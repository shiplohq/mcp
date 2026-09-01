import test from 'node:test';
import assert from 'node:assert/strict';

test('package entrypoint exports library APIs without starting the stdio server', async () => {
  const entrypoint = await import('../src/index');
  assert.equal(typeof entrypoint.deployStatic, 'function');
  assert.equal(typeof entrypoint.prepareStaticDeployment, 'function');
  assert.equal(typeof entrypoint.optimizeImage, 'function');
});
