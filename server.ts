import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, FunctionCall } from "@google/genai";
import dotenv from "dotenv";
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import { fetchUserDocs, fetchUserDoc, createDoc, updateDoc } from './src/lib/firestore-rest';
import { toolDeclarations, executeTool, validatePlanArgs } from './src/lib/server-tools';

dotenv.config();

const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
const adminApp = initializeApp({ projectId: firebaseConfig.projectId });
const adminAuth = getAuth(adminApp);

function getGenAIClient(customApiKey?: string) {
  const key = customApiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("No Gemini API key found. Please activate FORGE Brain Copilot with your Gemini API key.");
  }
  return new GoogleGenAI({
    apiKey: key.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

/**
 * Executes generateContent with transparent fallback across supported models
 * and retry backoff for transient 503 (high demand) or 429 errors.
 */
async function generateContentWithFallback(
  client: GoogleGenAI,
  params: {
    contents: any;
    config?: any;
    models?: string[];
  }
) {
  const models = params.models || ["gemini-3.7-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];
  let lastError: any = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await client.models.generateContent({
          model,
          contents: params.contents,
          config: params.config,
        });
        return response;
      } catch (err: any) {
        lastError = err;
        const errMsg = (err?.message || JSON.stringify(err) || "").toLowerCase();
        const isTransient =
          err?.status === 503 ||
          err?.status === 429 ||
          errMsg.includes("503") ||
          errMsg.includes("high demand") ||
          errMsg.includes("unavailable") ||
          errMsg.includes("resource_exhausted") ||
          errMsg.includes("rate");

        if (isTransient && attempt === 0) {
          // Wait 600ms before retrying same model
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        // If not transient or retry failed, move to next fallback model
        break;
      }
    }
  }

  throw lastError || new Error("Failed to generate response across all models.");
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.post("/api/test-gemini-key", async (req, res) => {
    try {
      const { apiKey } = req.body;
      const keyToTest = (typeof apiKey === 'string' && apiKey.trim()) ? apiKey.trim() : process.env.GEMINI_API_KEY;
      if (!keyToTest) {
        return res.status(400).json({ success: false, error: "API key is required" });
      }

      const client = new GoogleGenAI({
        apiKey: keyToTest,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      
      const response = await generateContentWithFallback(client, {
        contents: "ping",
      });

      res.json({ success: true, text: response.text });
    } catch (err: any) {
      console.error("Test Gemini Key Error:", err);
      res.status(400).json({ 
        success: false, 
        error: err.message || "Failed to validate Gemini API key",
        status: err.status || 400
      });
    }
  });

  app.post("/api/forge-brain", async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const { messages, geminiApiKey } = req.body; // Array of { role, content }
      const customKey = (req.headers['x-gemini-api-key'] as string) || geminiApiKey;
      const idToken = req.headers.authorization?.split('Bearer ')[1];
      
      if (!idToken) {
        res.write(JSON.stringify({ type: 'error', error: "Unauthorized: Missing ID token" }) + '\n');
        res.end();
        return;
      }

      // 1. Verify Identity
      let uid;
      try {
        const decodedToken = await adminAuth.verifyIdToken(idToken);
        uid = decodedToken.uid;
      } catch (err) {
        res.write(JSON.stringify({ type: 'error', error: "Unauthorized: Invalid ID token" }) + '\n');
        res.end();
        return;
      }
      
      let ai;
      try {
        ai = getGenAIClient(customKey);
      } catch (keyErr: any) {
        res.write(JSON.stringify({ type: 'error', error: keyErr.message }) + '\n');
        res.end();
        return;
      }
      
      const dbId = firebaseConfig.firestoreDatabaseId || '(default)';
      
      const context = { projectId: firebaseConfig.projectId, dbId, idToken, uid };

      const systemInstruction = `You are FORGE Brain, an advanced AI fitness intelligence and copilot. 
You act as a personal coach inside the FORGE gym app, proposing modifications to user workouts with optimistic concurrency control (OCC).
IMPORTANT RULES:
1. NEVER fabricate or guess user statistics, PRs, or workout data. ALWAYS use the provided tools (get_workouts, get_recent_workouts, get_exercise_history, get_progression_analysis) to retrieve actual data.
2. PROGRESSION & TARGETS: When the user asks "Why am I not progressing on bench?", "How has my squat progressed?", "Should I increase my weight?", or "What should I do today?", ALWAYS call 'get_progression_analysis' or 'get_exercise_history' to examine their real deterministic trajectory (e1RM trend, RIR, session volume, and recommended targets).
3. FITNESS DATA IS AUTHORITATIVE: If the user claims a PR in chat but the database shows otherwise, gently correct them based on recorded history.
4. PROPOSING WORKOUT CHANGES: When the user asks to modify a workout, add progressive overload, reschedule, change exercises, or optimize sets, ALWAYS use the 'propose_workout_change' tool. Ensure you fetch the target workout first with get_workouts to get its exact current 'version' (this is the baseVersion) and current sets.
5. OCC BASE VERSION: You MUST supply the exact current version of the workout as baseVersion.
6. SUMMARY: Provide a concise, professional summary explaining the physiological or progression rationale (e.g., "Progressive Overload: +2.5kg on Barbell Bench Press (80kg -> 82.5kg) & +2 reps on Lateral Raises").
7. PROGRESSION HEURISTICS: Strong performance -> suggest 2.5-5kg load increase or +1-2 reps. Stable -> maintain load, strive for rep PR. Regression or fatigue -> maintain or slight volume taper.
8. Keep answers practical, direct, evidence-based, concise, and actionable. Avoid generic motivational spam, excessive emojis, and NEVER say "As an AI...".`;

      const formattedContents = messages.map((m: any) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      let currentContents = [...formattedContents];
      let turnCount = 0;
      const MAX_TURNS = 5; // Prevent infinite loops

      while (turnCount < MAX_TURNS) {
        turnCount++;
        
        const response = await generateContentWithFallback(ai, {
          contents: currentContents,
          config: {
            systemInstruction: systemInstruction,
            temperature: 0.7,
            tools: [{ functionDeclarations: toolDeclarations }]
          }
        });

        const candidate = response.candidates?.[0];
        if (!candidate) {
          throw new Error("No response from model");
        }

        // Add the model's response to the conversation history
        currentContents.push(candidate.content);

        // Check for function calls
        const functionCalls = response.functionCalls;
        
        if (functionCalls && functionCalls.length > 0) {
          const functionResponses: any[] = [];
          
          for (const call of functionCalls) {
            // Check if it's a WRITE action or workout change proposal requiring user confirmation
            if (call.name === 'propose_workout_change') {
               let beforeState: any = {};
               try {
                 const targetId = typeof call.args?.targetEntityId === 'string' ? call.args.targetEntityId : '';
                 const targetWorkout = await fetchUserDoc(firebaseConfig.projectId, dbId, idToken, 'workouts', targetId);
                 if (targetWorkout) {
                   beforeState = {
                     title: targetWorkout.title,
                     scheduledDate: targetWorkout.scheduledDate,
                     status: targetWorkout.status,
                     sets: targetWorkout.sets
                   };
                 }
               } catch (e) {}

               const proposal = {
                 id: crypto.randomUUID(),
                 targetEntityType: 'WORKOUT',
                 targetEntityId: call.args?.targetEntityId,
                 baseVersion: call.args?.baseVersion,
                 status: 'PENDING_APPROVAL',
                 summary: call.args?.summary,
                 beforeState,
                 afterState: call.args?.afterState
               };

               res.write(JSON.stringify({
                 type: 'done',
                 response: candidate.content.parts.find((p: any) => p.text)?.text || "I have prepared a proposed modification for your review. See the diff below.",
                 proposal
               }) + '\n');
               res.end();
               return;
            }

            if (['create_plan', 'modify_plan', 'create_workout', 'modify_workout'].includes(call.name)) {
               if (call.name === 'create_plan' || call.name === 'modify_plan') {
                 try {
                   validatePlanArgs(call.args);
                 } catch (e: any) {
                   functionResponses.push({
                     functionResponse: {
                       id: call.id,
                        name: call.name,
                       response: { error: `Validation failed: ${e.message}. Please fix the plan structure and try again.` }
                     }
                   });
                   continue;
                 }
               }
               // We intercept the write action and return it as a proposed action
               res.write(JSON.stringify({
                 type: 'done',
                 response: candidate.content.parts.find((p: any) => p.text)?.text || "I have prepared a plan for you. Please review it below.",
                 proposedAction: {
                   id: call.id,
                        name: call.name,
                   args: call.args
                 }
               }) + '\n');
               res.end();
               return;
            }

            // Normal READ tool
            res.write(JSON.stringify({ type: 'tool', name: call.name }) + '\n');

            try {
              const result = await executeTool(call.name, call.args, context);
              functionResponses.push({
                functionResponse: {
                  id: call.id,
                        name: call.name,
                  response: result
                }
              });
            } catch (err: any) {
              functionResponses.push({
                functionResponse: {
                  id: call.id,
                        name: call.name,
                  response: { error: err.message }
                }
              });
            }
          }

          // Add the function responses back to the conversation history
          currentContents.push({
            role: 'user',
            parts: functionResponses
          });
          
          // Loop will continue and call generateContent again
        } else {
          // No function calls, we are done
          res.write(JSON.stringify({ type: 'done', response: candidate.content.parts.find((p: any) => p.text)?.text || "" }) + '\n');
          res.end();
          return;
        }
      }

      res.write(JSON.stringify({ type: 'error', error: "Exceeded max tool invocation turns." }) + '\n');
      res.end();
    } catch (error: any) {
      console.error("Gemini/Auth API Error:", error.message);
      res.write(JSON.stringify({ type: 'error', error: error.message || "Failed to generate AI response." }) + '\n');
      res.end();
    }
  });

  app.post("/api/optimize-workout", async (req, res) => {
    try {
      const idToken = req.headers.authorization?.split('Bearer ')[1];
      if (!idToken) return res.status(401).json({ error: "Unauthorized" });
      const decodedToken = await adminAuth.verifyIdToken(idToken);
      
      const { workout, strategy, geminiApiKey } = req.body;
      const customKey = (req.headers['x-gemini-api-key'] as string) || geminiApiKey;
      const ai = getGenAIClient(customKey);

      const prompt = `
        You are a strength and conditioning AI. The user is in the middle of a workout.
        They requested the strategy: ${strategy}.
        
        Workout: ${workout.title}
        Current Sets: ${JSON.stringify(workout.sets)}
        
        If strategy is SWAP_EXERCISE: Find the incomplete sets and replace the exercise with a suitable alternative for the same muscle group. Keep the load reasonable.
        If strategy is MID_SESSION_DELOAD: Find the incomplete sets and reduce the weight by 20% and reps by 2 to reduce fatigue while finishing the session.
        
        Return ONLY a JSON array of WorkoutSetItem objects. Do not wrap in markdown blocks. Just the JSON array.
        Only update sets where completed is false. Keep completed sets exactly the same.
        Every set must have id, exercise, reps, weight, completed (boolean).
      `;

      const response = await generateContentWithFallback(ai, {
        contents: prompt,
        config: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      });

      let newSets = workout.sets;
      try {
        if (response.text) {
          const raw = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
          newSets = JSON.parse(raw);
        }
      } catch (e) {
        console.error("Failed to parse AI optimization response:", e);
      }

      res.json({ success: true, sets: newSets });
    } catch (error: any) {
      console.error("Optimization error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/forge-apply-plan", async (req, res) => {
    try {
      const idToken = req.headers.authorization?.split('Bearer ')[1];
      if (!idToken) return res.status(401).json({ error: "Unauthorized" });
      const decodedToken = await adminAuth.verifyIdToken(idToken);
      const uid = decodedToken.uid;
      const { action } = req.body;
      
      validatePlanArgs(action.args);
      
      const planId = action.args.planId || crypto.randomUUID();
      const plan = {
        id: planId,
        userId: uid,
        name: action.args.name,
        goal: action.args.goal,
        isActive: true,
        days: action.args.days.map((d: any) => ({
          id: crypto.randomUUID(),
          name: d.name,
          exercises: d.exercises.map((e: any) => ({
            id: crypto.randomUUID(),
            exerciseId: e.exerciseId,
            targetSets: e.targetSets,
            targetRepsMin: e.targetRepsMin,
            targetRepsMax: e.targetRepsMax
          }))
        }))
      };
      
      const dbId = firebaseConfig.firestoreDatabaseId || '(default)';
      
      if (action.name === 'modify_plan' && action.args.planId) {
        await updateDoc(firebaseConfig.projectId, dbId, idToken, 'plans', planId, plan);
      } else {
        await createDoc(firebaseConfig.projectId, dbId, idToken, 'plans', planId, plan);
      }
      
      res.json({ success: true, plan });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/workouts/:id/mutate", async (req, res) => {
    try {
      const idToken = req.headers.authorization?.split("Bearer ")[1];
      if (!idToken) return res.status(401).json({ error: "Unauthorized" });
      const decodedToken = await adminAuth.verifyIdToken(idToken);
      const uid = decodedToken.uid;

      const { id } = req.params;
      const { baseVersion, updates, duration, volume } = req.body;

      const dbId = firebaseConfig.firestoreDatabaseId || "(default)";
      const adminDb = getFirestore(dbId);
      
      const workoutRef = adminDb.collection("workouts").doc(id);
      
      const result = await adminDb.runTransaction(async (transaction) => {
        const docSnap = await transaction.get(workoutRef);
        
        if (!docSnap.exists) {
          throw new Error("NOT_FOUND");
        }
        
        const data = docSnap.data();
        if (data?.userId !== uid) {
          throw new Error("UNAUTHORIZED");
        }
        
        if (data?.version !== baseVersion) {
          throw new Error(`CONFLICT:${data?.version || 0}:${JSON.stringify(data)}`);
        }
        
        const updatedWorkout = {
          ...data,
          ...updates,
          duration: duration !== undefined ? duration : data?.duration,
          volume: volume !== undefined ? volume : data?.volume,
          version: (data?.version || 0) + 1,
          updatedAt: new Date().toISOString()
        };
        
        // Ensure immutable fields
        updatedWorkout.id = id;
        updatedWorkout.userId = uid;
        
        transaction.set(workoutRef, updatedWorkout);
        
        // Also write to audit log
        const auditRef = adminDb.collection("mutation_audit_logs").doc();
        transaction.set(auditRef, {
          workoutId: id,
          userId: uid,
          previousVersion: baseVersion,
          newVersion: updatedWorkout.version,
          updates,
          timestamp: new Date().toISOString()
        });
        
        return updatedWorkout;
      });

      res.json({ success: true, workout: result });
    } catch (e: any) {
      if (e.message === "NOT_FOUND") {
        res.status(404).json({ error: "Workout not found" });
      } else if (e.message === "UNAUTHORIZED") {
        res.status(403).json({ error: "Unauthorized" });
      } else if (e.message.startsWith("CONFLICT:")) {
        const parts = e.message.split(":");
        const currentVersion = parseInt(parts[1], 10);
        const workoutData = JSON.parse(parts.slice(2).join(":"));
        res.status(409).json({ error: "Conflict: Stale version", currentVersion, workout: workoutData });
      } else {
        res.status(500).json({ error: e.message });
      }
    }
  });


  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
