/**
 * bucket.ts — MinIO / S3-compatible object storage client
 *
 * Uses AWS SDK v3 with forcePathStyle for MinIO compatibility.
 * All operations are safe to call concurrently.
 */

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "@my-better-t-app/env/server";

// ─── Singleton S3 client ──────────────────────────────────────────────────────

export const s3 = new S3Client({
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
  endpoint: env.MINIO_ENDPOINT,
  forcePathStyle: true, // required for MinIO
  region: "us-east-1", // MinIO ignores region but SDK requires it
});

export const BUCKET = env.MINIO_BUCKET;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Upload a WAV buffer to MinIO.
 * Returns the bucket key on success.
 */
export async function uploadToBucket(key: string, body: ArrayBuffer): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Body: Buffer.from(body),
      Bucket: BUCKET,
      ContentType: "audio/wav",
      Key: key,
    }),
  );
  return key;
}

/**
 * Download an object from MinIO and return its raw bytes.
 */
export async function getFromBucket(key: string): Promise<ArrayBuffer> {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!response.Body) throw new Error(`Empty body for bucket key: ${key}`);
  return (response.Body as unknown as { transformToArrayBuffer(): Promise<ArrayBuffer> }).transformToArrayBuffer();
}

/**
 * Returns true if an object exists in the bucket, false otherwise.
 * Uses HeadObject which is a lightweight metadata-only check.
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}
