export async function validate(payload) {
  if (typeof payload.config.greeting !== 'string' || payload.config.greeting.trim() === '') {
    throw new Error('greeting is required');
  }
  return { ok: true };
}

export async function apply(payload) {
  await validate(payload);
  return {
    ok: true,
    state: {
      greeting: payload.config.greeting,
      source: 'module-fixture',
    },
  };
}

export async function health(payload) {
  if (payload.config.failHealth === true) throw new Error('health failed by fixture config');
  return { ok: true, details: { greeting: payload.config.greeting } };
}
