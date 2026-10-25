const phase = process.argv[2];
let input = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input);
    const result = run(phase, payload);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
});

function run(activePhase, payload) {
  const config = payload.config ?? {};
  if (activePhase === 'validate') {
    assertValidConfig(config);
    return { ok: true };
  }
  if (activePhase === 'apply') {
    assertValidConfig(config);
    const items = Array.from({ length: config.maxItems }, (_, index) => `${config.greeting} #${index + 1}`);
    return {
      ok: true,
      state: {
        message: config.greeting,
        items,
        appliedAt: new Date().toISOString(),
      },
    };
  }
  if (activePhase === 'health') {
    if (config.failHealth === true) return { ok: false, error: 'config.failHealth is true' };
    return {
      ok: true,
      details: {
        itemCount: Array.isArray(payload.state?.items) ? payload.state.items.length : 0,
      },
    };
  }
  return { ok: false, error: `Unknown phase ${activePhase}` };
}

function assertValidConfig(config) {
  if (typeof config.greeting !== 'string' || config.greeting.trim() === '') {
    throw new Error('config.greeting must be a non-empty string');
  }
  if (!Number.isInteger(config.maxItems) || config.maxItems < 1 || config.maxItems > 100) {
    throw new Error('config.maxItems must be an integer between 1 and 100');
  }
}
