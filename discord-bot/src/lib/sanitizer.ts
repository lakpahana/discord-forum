import { createLogger } from './logger';

const logger = createLogger('sanitizer');

// Discord mention patterns
const DISCORD_USER_MENTION = /<@!?(\d{17,19})>/g;
const DISCORD_CHANNEL_MENTION = /<#(\d{17,19})>/g;
const DISCORD_ROLE_MENTION = /<@&(\d{17,19})>/g;
const DISCORD_EMOJI = /<a?:\w+:\d{17,19}>/g;
const DISCORD_TIMESTAMP = /<t:(\d{1,13})(?::([tTdDfFR]))?>/g;

// Script tag patterns
const SCRIPT_TAG = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const JAVASCRIPT_PROTOCOL = /javascript:/gi;
const ON_EVENT_ATTRIBUTES = /\son\w+\s*=/gi;

// PII patterns
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const PHONE_PATTERN = /(\+?1[-.\s]?)?(\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4})/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_PATTERN = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;

export interface SanitizationResult {
    sanitizedContent: string;
    removedMentions: string[];
    removedEmojis: string[];
    redactedPii: boolean;
    hadScriptTags: boolean;
}

export function sanitizeContent(content: string): SanitizationResult {
    let sanitized = content;
    const removedMentions: string[] = [];
    const removedEmojis: string[] = [];
    let redactedPii = false;
    let hadScriptTags = false;

    // Remove Discord mentions but log them
    const userMentions = sanitized.match(DISCORD_USER_MENTION);
    if (userMentions) {
        removedMentions.push(...userMentions);
        sanitized = sanitized.replace(DISCORD_USER_MENTION, '[User Mention]');
    }

    const channelMentions = sanitized.match(DISCORD_CHANNEL_MENTION);
    if (channelMentions) {
        removedMentions.push(...channelMentions);
        sanitized = sanitized.replace(DISCORD_CHANNEL_MENTION, '[Channel Mention]');
    }

    const roleMentions = sanitized.match(DISCORD_ROLE_MENTION);
    if (roleMentions) {
        removedMentions.push(...roleMentions);
        sanitized = sanitized.replace(DISCORD_ROLE_MENTION, '[Role Mention]');
    }

    // Remove Discord emojis but log them
    const emojis = sanitized.match(DISCORD_EMOJI);
    if (emojis) {
        removedEmojis.push(...emojis);
        sanitized = sanitized.replace(DISCORD_EMOJI, '[Emoji]');
    }

    // Remove Discord timestamps
    sanitized = sanitized.replace(DISCORD_TIMESTAMP, '[Timestamp]');

    // Remove script tags and dangerous attributes
    if (SCRIPT_TAG.test(sanitized)) {
        hadScriptTags = true;
        sanitized = sanitized.replace(SCRIPT_TAG, '[Removed Script]');
    }

    sanitized = sanitized.replace(JAVASCRIPT_PROTOCOL, 'javascript-removed:');
    sanitized = sanitized.replace(ON_EVENT_ATTRIBUTES, ' data-removed-event=');

    // Redact PII
    if (EMAIL_PATTERN.test(sanitized)) {
        redactedPii = true;
        sanitized = sanitized.replace(EMAIL_PATTERN, '[Email Redacted]');
    }

    if (PHONE_PATTERN.test(sanitized)) {
        redactedPii = true;
        sanitized = sanitized.replace(PHONE_PATTERN, '[Phone Redacted]');
    }

    if (SSN_PATTERN.test(sanitized)) {
        redactedPii = true;
        sanitized = sanitized.replace(SSN_PATTERN, '[SSN Redacted]');
    }

    if (CREDIT_CARD_PATTERN.test(sanitized)) {
        redactedPii = true;
        sanitized = sanitized.replace(CREDIT_CARD_PATTERN, '[Card Number Redacted]');
    }

    // Log sanitization results
    if (removedMentions.length > 0 || removedEmojis.length > 0 || redactedPii || hadScriptTags) {
        logger.info({
            removedMentions: removedMentions.length,
            removedEmojis: removedEmojis.length,
            redactedPii,
            hadScriptTags,
        }, 'Content sanitization performed');
    }

    return {
        sanitizedContent: sanitized,
        removedMentions,
        removedEmojis,
        redactedPii,
        hadScriptTags,
    };
}

export function sanitizeForHtml(content: string): string {
    // Basic HTML escaping for safety
    return content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

export function convertToHtml(content: string): string {
    // Convert Discord markdown to basic HTML
    let html = content;

    // Bold **text**
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Italic *text*
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Strikethrough ~~text~~
    html = html.replace(/~~(.*?)~~/g, '<del>$1</del>');

    // Code `text`
    html = html.replace(/`(.*?)`/g, '<code>$1</code>');

    // Code blocks ```text```
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // Convert newlines to <br>
    html = html.replace(/\n/g, '<br>');

    // Convert URLs to links (simple pattern)
    html = html.replace(
        /(https?:\/\/[^\s]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    return html;
}
