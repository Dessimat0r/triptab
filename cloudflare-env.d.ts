declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    RECEIPT_AI_OWNER_EMAIL?: string;
    // Optional transactional email (password reset and address confirmation).
    RESEND_API_KEY?: string;
    EMAIL_FROM?: string;
  }
}
