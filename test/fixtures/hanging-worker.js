// NOTE: worker 夹具：apply 阶段且 config.hang=true 时永不输出，用于触发 runJsonProcess 超时与 SIGKILL；其余按阶段正常返回。
// NOTE(en): Worker fixture: it never responds during apply when config.hang=true, exercising runJsonProcess timeout and SIGKILL; otherwise it answers per phase.
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8');
});
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const phase = process.argv[2];
  if (phase === 'apply' && payload.config?.hang === true) {
    setInterval(() => undefined, 1000);
    return;
  }
  if (phase === 'apply') {
    console.log(JSON.stringify({ ok: true, state: { greeting: payload.config.greeting, source: 'worker-fixture' } }));
    return;
  }
  if (phase === 'health') {
    console.log(JSON.stringify({ ok: true, details: { greeting: payload.config.greeting } }));
    return;
  }
  console.log(JSON.stringify({ ok: true }));
});
