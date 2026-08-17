const fs = require('fs');
let code = fs.readFileSync('src/components/WorkoutDetailModal.tsx', 'utf8');

// Add mutateWorkout to imports from '../lib/api'
code = code.replace(/import \{ saveWorkout, getWorkouts \} from '\.\.\/lib\/api';/, "import { saveWorkout, getWorkouts, mutateWorkout } from '../lib/api';");

// Replace handleSave
const newHandleSave = `  const handleSave = async () => {
    setSaving(true);
    try {
      const isCompleting = !isEditMode;
      const newStatus = isCompleting ? 'COMPLETED' : workout.status;
      
      const updates = {
        title,
        scheduledDate,
        status: newStatus,
        sets,
        exerciseNotes
      };
      
      const vol = calculateVolume(sets);
      
      const result = await mutateWorkout(workout.id, workout.version, updates, duration, vol);
      
      if (isCompleting) {
        setShowCelebration(true);
        // Do not close immediately, let Celebration modal take over
        onSave(result); // updates the parent state in the background
      } else {
        onSave(result);
        onClose();
      }
    } catch (e: any) {
      console.error(e);
      if (e.status === 409) {
        if (window.confirm(\`Conflict: The workout was modified on another device (v\${e.currentVersion}). Do you want to force override with your local changes?\`)) {
          // Retry with the current server version
          try {
            const isCompleting = !isEditMode;
            const newStatus = isCompleting ? 'COMPLETED' : workout.status;
            const updates = { title, scheduledDate, status: newStatus, sets, exerciseNotes };
            const vol = calculateVolume(sets);
            const result = await mutateWorkout(workout.id, e.currentVersion, updates, duration, vol);
            if (isCompleting) {
              setShowCelebration(true);
              onSave(result);
            } else {
              onSave(result);
              onClose();
            }
          } catch (retryErr: any) {
            alert(\`Failed to force update: \${retryErr.message}\`);
          }
        } else {
          // Cancelled, user can manually re-sync or reload
        }
      } else {
        alert(\`Failed to save workout: \${e.message}\`);
      }
    } finally {
      setSaving(false);
    }
  };`;

// replace old handleSave
const startIdx = code.indexOf('  const handleSave = async () => {');
const endIdx = code.indexOf('  const handleSimulateExternalEdit = async () => {', startIdx);

if (startIdx > -1 && endIdx > -1) {
  code = code.substring(0, startIdx) + newHandleSave + "\n\n" + code.substring(endIdx);
} else {
  console.log("Could not find handleSave");
}

fs.writeFileSync('src/components/WorkoutDetailModal.tsx', code);
