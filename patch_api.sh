cat << 'INNER_EOF' >> src/lib/api.ts

export async function mutateWorkout(workoutId: string, baseVersion: number, updates: Partial<Workout>, duration?: number, volume?: number): Promise<Workout> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not authenticated');

  const res = await fetch(`/api/workouts/${workoutId}/mutate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ baseVersion, updates, duration, volume })
  });

  const data = await res.json();
  if (!res.ok) {
    if (res.status === 409) {
      const err: any = new Error(data.error || 'Stale version');
      err.status = 409;
      err.currentVersion = data.currentVersion;
      err.workout = data.workout;
      throw err;
    }
    throw new Error(data.error || 'Failed to mutate workout');
  }

  // Update localStorage cache
  if (data.workout && data.workout.userId) {
    const all = await getWorkouts(data.workout.userId);
    const exists = all.some(w => w.id === data.workout.id);
    const nextList = exists 
      ? all.map(w => w.id === data.workout.id ? data.workout : w)
      : [data.workout, ...all];
    localStorage.setItem(`forge_workouts_${data.workout.userId}`, JSON.stringify(nextList));
  }

  return data.workout;
}
INNER_EOF
