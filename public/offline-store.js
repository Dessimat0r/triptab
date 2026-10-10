/* Shared by the offline screen, service worker and signed-in app. */
(() => {
  'use strict';
  const name = 'triptab-capture-v1';
  const open = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('settings', { keyPath: 'key' });
        db.createObjectStore('contexts', { keyPath: 'accountId' });
        db.createObjectStore('queue', { keyPath: 'id' });
        db.createObjectStore('shared', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error('Local storage is unavailable.'));
    });
  const hydrate = (value) =>
    Array.isArray(value)
      ? value.map(hydrate)
      : value?.photo?.bytes
        ? {
            ...value,
            photo: new Blob([value.photo.bytes], { type: value.photo.type }),
          }
        : value;
  const pack = async (photo) =>
    photo
      ? { bytes: await photo.arrayBuffer(), type: photo.type, size: photo.size }
      : undefined;
  async function operation(store, method, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        store,
        ['get', 'getAll'].includes(method) ? 'readonly' : 'readwrite',
      );
      const request = tx.objectStore(store)[method](value);
      let result;
      request.onsuccess = () => {
        result = request.result;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(hydrate(result));
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(
          Error('Unable to save on this device. Check its available storage.'),
        );
      };
    });
  }
  async function enqueue(entry) {
    if (
      !entry ||
      typeof entry.accountId !== 'string' ||
      typeof entry.tripId !== 'string' ||
      entry.id !== entry.expense?.id
    )
      throw Error('Check the expense before saving.');
    const packed = { ...entry, photo: await pack(entry.photo) };
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite'),
        store = tx.objectStore('queue');
      let error = 'Unable to save on this device.';
      const current = store.getAll();
      current.onsuccess = () => {
        const other = current.result.filter((row) => row.id !== entry.id);
        if (
          other.length >= 50 ||
          (entry.photo?.size ?? 0) > 10 * 1024 * 1024 ||
          other.reduce((sum, row) => sum + (row.photo?.size ?? 0), 0) +
            (entry.photo?.size ?? 0) >
            50 * 1024 * 1024
        ) {
          error =
            'This device’s queue is full. Sync or remove pending expenses first.';
          tx.abort();
          return;
        }
        store.put(packed);
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error(error));
      };
    });
  }
  async function receivePhoto(file) {
    if (
      !file ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      !file.size ||
      file.size > 10 * 1024 * 1024
    )
      throw Error('Share one JPEG, PNG or WebP photo under 10 MB.');
    const entry = {
      id: crypto.randomUUID(),
      photo: await pack(file),
      createdAt: Date.now(),
    };
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('shared', 'readwrite'),
        rows = tx.objectStore('shared');
      rows.clear();
      rows.put(entry);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(Error('The shared photo could not be saved.'));
      };
    });
    return entry.id;
  }
  globalThis.TripTabOffline = { operation, enqueue, receivePhoto };
})();
