import crypto from 'crypto';

export function hashUserId(userId: string): string {
    const pepper = process.env.PII_PEPPER;
    if (!pepper) {
        throw new Error('PII_PEPPER environment variable is required');
    }

    const hash = crypto
        .createHash('sha256')
        .update(userId + pepper)
        .digest('hex');

    // Return first 12 characters as specified
    return hash.substring(0, 12);
}

export function validatePepper(): void {
    const pepper = process.env.PII_PEPPER;
    if (!pepper) {
        throw new Error('PII_PEPPER environment variable is required');
    }

    // Validate that pepper is 256 bits (64 hex chars)
    if (!/^[0-9a-fA-F]{64}$/.test(pepper)) {
        throw new Error('PII_PEPPER must be a 256-bit (64 character) hex string');
    }
}
