/**
 * One-time script to populate Firestore with sample tournament and player data.
 * Run from the browser console or import and execute in your app during development.
 *
 * Usage in browser console:
 *   import { createSampleTournamentData } from '../src/firebaseHelpers.js';
 *   await createSampleTournamentData();
 */

// This file is a reminder — the actual function is exported from firebaseHelpers.js
// To use it, call this in your browser console:

/*
  import { createSampleTournamentData } from './src/firebaseHelpers.js';
  const result = await createSampleTournamentData();
  console.log('Sample data created:', result);
*/

export const instructions = `
To populate sample tournament data:

1. Open your app in the browser (http://localhost:5173 or similar)
2. Open browser DevTools (F12)
3. Go to the Console tab
4. Paste and run this:

const { createSampleTournamentData } = await import('./src/firebaseHelpers.js');
await createSampleTournamentData();
console.log('✅ Sample data created!', result);

5. Refresh the page or navigate to /weekly
6. You should now see a tournament with 32 players in the group stage and bracket!

To clear the data later, delete the collections in Firebase Console:
- tournaments
- players
`;

console.log(instructions);
