import crypto from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { decrypt, encrypt, sha256 } from './crypto.js';

/**
 * File storage. Files are encrypted with AES-256-GCM before they reach the disk.
 * The interface matches an object store (put/get/delete by key) so an S3/MinIO driver can replace the local one.
 */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const local: StorageDriver = {
  async put(key, data) {
    const full = path.join(config.storageDir, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { mode: 0o600 });
  },
  get: (key) => readFile(path.join(config.storageDir, key)),
  delete: (key) => rm(path.join(config.storageDir, key), { force: true }),
};

const driver: StorageDriver = local;

export async function putFile(prefix: string, data: Buffer) {
  const now = new Date();
  const key = `${prefix}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}`;
  await driver.put(key, encrypt(data));
  return { storageKey: key, sha256: sha256(data), size: data.length };
}

export async function getFile(key: string): Promise<Buffer> {
  return decrypt(await driver.get(key));
}

export const deleteFile = (key: string) => driver.delete(key);
