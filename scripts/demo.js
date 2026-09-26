const [phase, household, date] = process.argv.slice(2);
if (!['remember', 'pick-up', 'state'].includes(phase) || !household || !date) {
  throw new Error('Usage: pnpm demo <remember|pick-up|state> <household> <YYYY-MM-DD>');
}

const base = process.env.HOME_URL ?? 'http://127.0.0.1:43188';
const requests = {
  remember: ['/api/remember', { household, date, utterance: "Mom is coming at 7, and she can't have peanuts" }],
  'pick-up': ['/api/pick-up-dinner', { household, date, utterance: 'Pick up dinner for Mom tonight' }]
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
