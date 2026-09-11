import { Timestamp, type Firestore } from "@google-cloud/firestore";

type Data = Record<string, any>;
type Filter = [string, string, any];

// A sequential transaction double; enforces Firestore's reads-before-writes rule.
// This does not emulate Firestore's concurrent transaction conflict detection.
export function memoryFirestore() {
  const data = new Map<string, Data>();
  const scalar = (value: any) => value instanceof Timestamp ? value.toMillis() : value;
  const collection = (name: string, filters: Filter[] = []) => ({
    doc: (id: string) => ref(`${name}/${id}`),
    where: (field: string, operator: string, value: any) => collection(name, [...filters, [field, operator, value]]),
    async add(value: Data) {
      const doc = ref(`${name}/${data.size}`);
      await doc.set(value);
      return doc;
    },
    async get() {
      const docs = [];
      for (const [path, value] of data) {
        if (!path.startsWith(`${name}/`)) continue;
        if (!filters.every(([field, operator, expected]) => {
          const actual = scalar(value[field]);
          if (operator === "==") return actual === scalar(expected);
          if (operator === "<=") return actual <= scalar(expected);
          if (operator === "in") return expected.includes(actual);
          throw new Error(`Unsupported test query: ${operator}`);
        })) continue;
        docs.push(await ref(path).get());
      }
      return { docs };
    }
  });
  const ref = (path: string) => ({
    path,
    async get() {
      const value = data.get(path);
      return { id: path.split("/").at(-1)!, exists: Boolean(value), data: () => value, ref: ref(path) };
    },
    async set(value: Data, options?: { merge?: boolean }) {
      data.set(path, { ...(options?.merge ? data.get(path) : {}), ...value });
    }
  });
  const db = {
    collection,
    async runTransaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
      const writes: (() => Promise<void>)[] = [];
      const result = await work({
        async get(target: { get: () => Promise<unknown> }) {
          if (writes.length) throw new Error("Firestore transactions require all reads before writes");
          return target.get();
        },
        set(target: ReturnType<typeof ref>, value: Data, options?: { merge?: boolean }) {
          writes.push(() => target.set(value, options));
        },
        update(target: ReturnType<typeof ref>, value: Data) {
          writes.push(() => target.set(value, { merge: true }));
        }
      });
      for (const write of writes) await write();
      return result;
    }
  };
  return { db: db as unknown as Firestore, data };
}
