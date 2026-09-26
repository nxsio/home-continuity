const [phase, household, date, ...words] = process.argv.slice(2);
if (!['remember', 'pick-up', 'state'].includes(phase) || !household || !date) {
  throw new Error('Usage: pnpm demo <remember|pick-up|state> <household> <YYYY-MM-DD> [utterance]');
}

const base = process.env.HOME_URL ?? 'http://127.0.0.1:43188';
const utterance = words.join(' ');
const requests = {
  remember: ['/api/remember', { household, date, utterance: utterance || "Mom is coming for dinner at 7 PM, and she can't have peanuts" }],
  'pick-up': ['/api/pick-up-dinner', { household, date, utterance: utterance || 'Pick up dinner for Mom tonight' }]
};
let response;
if (phase === 'state') {
  response = await fetch(`${base}/api/state?household=${encodeURIComponent(household)}&date=${encodeURIComponent(date)}`);
} else {
  const [path, body] = requests[phase];
  response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}
const result = await response.json();
console.log(JSON.stringify({ httpStatus: response.status, ...result }, null, 2));
if (!response.ok) process.exitCode = 1;
