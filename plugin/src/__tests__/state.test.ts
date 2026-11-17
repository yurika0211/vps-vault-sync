import { createState } from '../state';

function makeMockStorage(initial: any = {}) {
  let stored = { ...initial };
  return {
    load: jest.fn(async () => ({ ...stored })),
    save: jest.fn(async (data: any) => { stored = { ...data }; }),
  };
}

test('loads empty state when no data exists', async () => {
  const storage = makeMockStorage({});
  const state = await createState(storage);
  expect(state.lastSyncTimestamp).toBe(0);
  expect(state.files).toEqual({});
});

test('loads persisted state', async () => {
  const storage = makeMockStorage({ lastSyncTimestamp: 100, files: { 'a.md': 'hash1' } });
  const state = await createState(storage);
  expect(state.lastSyncTimestamp).toBe(100);
  expect(state.files['a.md']).toBe('hash1');
});

test('setFileHash saves to storage', async () => {
  const storage = makeMockStorage({});
  const state = await createState(storage);
  await state.setFileHash('notes/foo.md', 'abc123');
  expect(state.files['notes/foo.md']).toBe('abc123');
  expect(storage.save).toHaveBeenCalledWith(
    expect.objectContaining({ files: { 'notes/foo.md': 'abc123' } })
  );
});

test('removeFileHash removes from state', async () => {
  const storage = makeMockStorage({ files: { 'a.md': 'h' }, lastSyncTimestamp: 0 });
  const state = await createState(storage);
  await state.removeFileHash('a.md');
  expect(state.files['a.md']).toBeUndefined();
});

test('setLastSyncTimestamp updates and persists', async () => {
  const storage = makeMockStorage({});
  const state = await createState(storage);
  await state.setLastSyncTimestamp(12345);
  expect(state.lastSyncTimestamp).toBe(12345);
  expect(storage.save).toHaveBeenCalledWith(
    expect.objectContaining({ lastSyncTimestamp: 12345 })
  );
});

test('deferSaves keeps writes in memory until flush', async () => {
  const storage = makeMockStorage({});
  const state = await createState(storage);
  state.deferSaves = true;
  await state.setFileHash('a.md', 'h1');
  await state.setFileHash('b.md', 'h2');
  await state.setLastSyncTimestamp(7);
  expect(storage.save).not.toHaveBeenCalled();

  await state.flush();
  expect(storage.save).toHaveBeenCalledTimes(1);
  expect(storage.save).toHaveBeenCalledWith(expect.objectContaining({ lastSyncTimestamp: 7, files: { 'a.md': 'h1', 'b.md': 'h2' } }));

  await state.flush(); // nothing dirty any more
  expect(storage.save).toHaveBeenCalledTimes(1);
});

test('mutators save immediately when saves are not deferred', async () => {
  const storage = makeMockStorage({});
  const state = await createState(storage);
  await state.setFileHash('a.md', 'h1');
  await state.removeFileHash('a.md');
  expect(storage.save).toHaveBeenCalledTimes(2);
});
