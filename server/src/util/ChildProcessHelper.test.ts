import { ChildProcessHelper } from './ChildProcessHelper.ts';

test('getStdout keeps the runtime buffer limit unless the caller overrides it', async () => {
  const helper = new ChildProcessHelper();
  const size = 3 * 1024 * 1024;
  const args = ['-e', `process.stdout.write('a'.repeat(${size}))`];

  await expect(helper.getStdout(process.execPath, args)).rejects.toMatchObject({
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  });
  const output = await helper.getStdout(process.execPath, args, {
    maxBuffer: 8 * 1024 * 1024,
  });
  expect(output).toHaveLength(size);
});
