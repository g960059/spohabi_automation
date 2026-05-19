import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const client = new SecretManagerServiceClient();
const cache = new Map<string, Promise<string>>();

export async function readSecret(nameOrPath: string | undefined): Promise<string | undefined> {
  if (!nameOrPath) return undefined;
  const name = normalizeSecretName(nameOrPath);
  if (!cache.has(name)) {
    cache.set(
      name,
      client.accessSecretVersion({ name }).then(([version]) => {
        const data = version.payload?.data?.toString("utf8");
        if (!data) throw new Error(`Secret has no payload: ${name}`);
        return data;
      })
    );
  }
  return cache.get(name);
}

function normalizeSecretName(value: string): string {
  if (value.includes("/versions/")) return value;
  return `${value}/versions/latest`;
}
