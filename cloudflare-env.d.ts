declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    RECEIPT_AI_OWNER_EMAIL?: string;
  }
}
