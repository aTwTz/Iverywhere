import { GleamRuntime } from './gleamRuntime.js';
import { JsRuntime } from './jsRuntime.js';

export function createRuntime(definition, context) {
  const adapter = definition.adapter ?? 'js';
  if (adapter === 'js') return new JsRuntime(context);
  if (adapter === 'gleam') return new GleamRuntime(context);
  throw new Error(`Unsupported runtime adapter: ${adapter}`);
}
