import type { Expense, Trip } from './model';

export type OfflineExpense = {
  id: string;
  accountId: string;
  tripId: string;
  expense: Expense;
  photo?: Blob;
  receiptId?: string;
  createdAt: number;
};
export type OfflineContext = {
  accountId: string;
  name: string;
  trips: Pick<Trip, 'id' | 'name' | 'currency' | 'members'>[];
  currencies: readonly { code: string; name: string }[];
};
type Store = {
  operation: <T>(
    store: string,
    method: 'get' | 'getAll' | 'put' | 'delete',
    value?: unknown,
  ) => Promise<T>;
  enqueue: (entry: OfflineExpense) => Promise<void>;
  receivePhoto: (file: Blob) => Promise<string>;
};
declare global {
  interface Window {
    TripTabOffline?: Store;
  }
}
let pending: Promise<Store> | undefined;
export function offlineStore(): Promise<Store> {
  if (window.TripTabOffline) return Promise.resolve(window.TripTabOffline);
  if (!pending)
    pending = new Promise<Store>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/offline-store.js';
      script.onload = () =>
        window.TripTabOffline
          ? resolve(window.TripTabOffline)
          : reject(Error('Offline capture is unavailable.'));
      script.onerror = () => {
        pending = undefined;
        reject(Error('Offline capture is unavailable.'));
      };
      document.head.appendChild(script);
    });
  return pending;
}
export async function clearOfflineContext() {
  const store = await offlineStore();
  const active = await store.operation<{ accountId: string } | undefined>(
    'settings',
    'get',
    'active',
  );
  if (active) await store.operation('contexts', 'delete', active.accountId);
  await store.operation('settings', 'delete', 'active');
  const photos = await store.operation<{ id: string }[]>('shared', 'getAll');
  for (const photo of photos)
    await store.operation('shared', 'delete', photo.id);
}

export async function eraseAccountCapture(accountId: string) {
  const store = await offlineStore();
  const entries = await store.operation<OfflineExpense[]>('queue', 'getAll');
  for (const entry of entries.filter((entry) => entry.accountId === accountId))
    await store.operation('queue', 'delete', entry.id);
  await store.operation('contexts', 'delete', accountId);
  const active = await store.operation<{ accountId: string } | undefined>(
    'settings',
    'get',
    'active',
  );
  if (active?.accountId === accountId)
    await store.operation('settings', 'delete', 'active');
  const shared = await store.operation<{ id: string }[]>('shared', 'getAll');
  for (const photo of shared)
    await store.operation('shared', 'delete', photo.id);
}
