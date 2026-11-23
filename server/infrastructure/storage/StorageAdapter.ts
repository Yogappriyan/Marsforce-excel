import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Storage } from '@google-cloud/storage';
import { del, get, head, put } from '@vercel/blob';
import { env } from '../../config/env.ts';

const ENC_MAGIC = Buffer.from('MFENC1', 'ascii');
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKeyBuffer(): Buffer | null {
  if (!env.dataEncryptionKey) return null;
  return crypto.createHash('sha256').update(env.dataEncryptionKey).digest();
}

export function encryptStoragePayload(data: Buffer): Buffer {
  const key = getEncryptionKeyBuffer();
  if (!key) return data;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENC_MAGIC, iv, tag, encrypted]);
}

export function decryptStoragePayload(payload: Buffer): Buffer {
  if (payload.length < ENC_MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH) {
    return payload;
  }
  if (!payload.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) {
    return payload;
  }
  const key = getEncryptionKeyBuffer();
  if (!key) {
    throw new Error('Encrypted storage object cannot be decrypted because DATA_ENCRYPTION_KEY is not configured.');
  }
  const ivStart = ENC_MAGIC.length;
  const tagStart = ivStart + IV_LENGTH;
  const cipherStart = tagStart + AUTH_TAG_LENGTH;
  const iv = payload.subarray(ivStart, tagStart);
  const tag = payload.subarray(tagStart, cipherStart);
  const ciphertext = payload.subarray(cipherStart);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export interface StorageAdapter {
  readonly driverName: 'VERCEL_BLOB' | 'GCS' | 'LOCAL_DEV';
  putObject(key: string, data: Buffer, contentType: string): Promise<void>;
  getObjectBuffer(key: string): Promise<Buffer>;
  getObjectStream(key: string): Promise<NodeJS.ReadableStream>;
  deleteObject(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

class VercelBlobStorageAdapter implements StorageAdapter {
  public readonly driverName = 'VERCEL_BLOB' as const;
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private normalizeKey(key: string): string {
    const sanitized = key.replace(/^\/+/, '');
    if (!sanitized || sanitized.includes('\0') || sanitized.includes('..')) {
      throw new Error('Invalid storage key');
    }
    return sanitized;
  }

  async putObject(key: string, data: Buffer, contentType: string): Promise<void> {
    const pathname = this.normalizeKey(key);
    const payload = encryptStoragePayload(data);
    await put(pathname, payload, {
      access: 'private',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      token: this.token,
    });
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const pathname = this.normalizeKey(key);
    const res = await get(pathname, {
      access: 'private',
      useCache: false,
      token: this.token,
    });
    if (!res || res.statusCode !== 200 || !res.stream) {
      throw new Error('Stored object not found in Vercel Blob');
    }
    const chunks: Buffer[] = [];
    const reader = res.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return decryptStoragePayload(Buffer.concat(chunks));
  }

  async getObjectStream(key: string): Promise<NodeJS.ReadableStream> {
    const decrypted = await this.getObjectBuffer(key);
    return bufferToStream(decrypted);
  }

  async deleteObject(key: string): Promise<void> {
    const pathname = this.normalizeKey(key);
    await del(pathname, { token: this.token });
  }

  async exists(key: string): Promise<boolean> {
    const pathname = this.normalizeKey(key);
    try {
      await head(pathname, { token: this.token });
      return true;
    } catch {
      return false;
    }
  }
}

class GCSStorageAdapter implements StorageAdapter {
  public readonly driverName = 'GCS' as const;
  private storage: Storage;
  private bucketName: string;

  constructor(bucketName: string, serviceAccountJson: string) {
    const credentials = JSON.parse(serviceAccountJson);
    this.storage = new Storage({ credentials, projectId: credentials.project_id });
    this.bucketName = bucketName;
  }

  async putObject(key: string, data: Buffer, contentType: string): Promise<void> {
    const payload = encryptStoragePayload(data);
    const file = this.storage.bucket(this.bucketName).file(key);
    await file.save(payload, {
      contentType,
      resumable: payload.length > 5 * 1024 * 1024,
      metadata: { cacheControl: 'private, max-age=0, no-store' },
    });
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const [contents] = await this.storage.bucket(this.bucketName).file(key).download();
    return decryptStoragePayload(contents);
  }

  async getObjectStream(key: string): Promise<NodeJS.ReadableStream> {
    if (getEncryptionKeyBuffer()) {
      const decrypted = await this.getObjectBuffer(key);
      return bufferToStream(decrypted);
    }
    return this.storage.bucket(this.bucketName).file(key).createReadStream();
  }

  async deleteObject(key: string): Promise<void> {
    await this.storage.bucket(this.bucketName).file(key).delete({ ignoreNotFound: true });
  }

  async exists(key: string): Promise<boolean> {
    const [exists] = await this.storage.bucket(this.bucketName).file(key).exists();
    return exists;
  }
}

class LocalDiskStorageAdapter implements StorageAdapter {
  public readonly driverName = 'LOCAL_DEV' as const;
  private baseDir: string;

  constructor() {
    this.baseDir = env.isVercel
      ? path.join(os.tmpdir(), 'marsforce', 'storage')
      : path.resolve(process.cwd(), '.data', 'storage');
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
  }

  private resolveSafePath(key: string): string {
    const sanitized = key.replace(/^\/+/, '');
    if (!sanitized || sanitized.includes('\0')) {
      throw new Error('Invalid storage key');
    }
    const target = path.resolve(this.baseDir, sanitized);
    if (!target.startsWith(this.baseDir + path.sep) && target !== this.baseDir) {
      throw new Error('Invalid storage key path traversal attempt');
    }
    return target;
  }

  async putObject(key: string, data: Buffer, _contentType: string): Promise<void> {
    const target = this.resolveSafePath(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const payload = encryptStoragePayload(data);
    await fs.promises.writeFile(target, payload, { mode: 0o600 });
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const target = this.resolveSafePath(key);
    const raw = await fs.promises.readFile(target);
    return decryptStoragePayload(raw);
  }

  async getObjectStream(key: string): Promise<NodeJS.ReadableStream> {
    const target = this.resolveSafePath(key);
    if (!fs.existsSync(target)) {
      throw new Error('Stored object not found');
    }
    const decrypted = await this.getObjectBuffer(key);
    return bufferToStream(decrypted);
  }

  async deleteObject(key: string): Promise<void> {
    const target = this.resolveSafePath(key);
    await fs.promises.rm(target, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const target = this.resolveSafePath(key);
    return fs.existsSync(target);
  }
}

let storageInstance: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (!storageInstance) {
    if (env.storageDriver === 'vercel_blob' && env.blobReadWriteToken) {
      storageInstance = new VercelBlobStorageAdapter(env.blobReadWriteToken);
    } else if (env.storageDriver === 'gcs' && env.gcsBucket && env.gcsServiceAccountJson) {
      try {
        storageInstance = new GCSStorageAdapter(env.gcsBucket, env.gcsServiceAccountJson);
      } catch (err) {
        console.warn('[Storage] Failed to initialize GCS adapter, falling back to DEV LOCAL DISK:', (err as Error).message);
        storageInstance = new LocalDiskStorageAdapter();
      }
    } else {
      storageInstance = new LocalDiskStorageAdapter();
    }
  }
  return storageInstance;
}

export function bufferToStream(buf: Buffer): Readable {
  return Readable.from(buf);
}
