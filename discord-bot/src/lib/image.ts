import sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import crypto from 'crypto';
import { createLogger } from './logger';

const logger = createLogger('image');

let s3Client: S3Client;

export function initializeS3(): void {
    s3Client = new S3Client({
        region: process.env.S3_REGION || 'us-east-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
    });
}

export interface ProcessedImage {
    url: string;
    width: number;
    height: number;
    sizeBytes: number;
}

export interface ImageProcessingOptions {
    maxWidth?: number;
    maxHeight?: number;
    maxSizeBytes?: number;
}

export async function processAndUploadImage(
    imageBuffer: Buffer,
    filename: string,
    options: ImageProcessingOptions = {}
): Promise<ProcessedImage> {
    const {
        maxWidth = parseInt(process.env.IMAGE_MAX_W || '1920'),
        maxHeight = parseInt(process.env.IMAGE_MAX_H || '1080'),
        maxSizeBytes = parseInt(process.env.IMAGE_MAX_MB || '10') * 1024 * 1024,
    } = options;

    logger.debug({ filename, maxWidth, maxHeight, maxSizeBytes }, 'Processing image');

    // Check file size before processing
    if (imageBuffer.length > maxSizeBytes) {
        throw new Error(`Image too large: ${imageBuffer.length} bytes (max: ${maxSizeBytes})`);
    }

    try {
        // Initialize S3 client if not already done
        if (!s3Client) {
            initializeS3();
        }

        // Process image with Sharp
        const processedBuffer = await sharp(imageBuffer)
            // Strip EXIF data for privacy
            .rotate() // Auto-rotate based on EXIF orientation, then remove EXIF
            .resize(maxWidth, maxHeight, {
                fit: 'inside',
                withoutEnlargement: true,
            })
            // Convert to WebP for optimal compression
            .webp({
                quality: 85,
                effort: 4,
            })
            .toBuffer();

        // Get image metadata
        const metadata = await sharp(processedBuffer).metadata();
        const width = metadata.width || 0;
        const height = metadata.height || 0;

        // Generate S3 key with timestamp and content hash
        const timestamp = new Date();
        const year = timestamp.getFullYear();
        const month = String(timestamp.getMonth() + 1).padStart(2, '0');
        const contentHash = crypto
            .createHash('sha256')
            .update(processedBuffer)
            .update(timestamp.toISOString())
            .digest('hex')
            .slice(0, 16);

        const s3Key = `${year}/${month}/${contentHash}.webp`;

        // Upload to S3
        const uploadCommand = new Upload({
            client: s3Client,
            params: {
                Bucket: process.env.S3_BUCKET!,
                Key: s3Key,
                Body: processedBuffer,
                ContentType: 'image/webp',
                CacheControl: 'max-age=31536000', // 1 year
                Metadata: {
                    'original-filename': filename,
                    'processed-at': timestamp.toISOString(),
                },
            },
        });

        await uploadCommand.done();

        const url = `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${s3Key}`;

        logger.info({
            filename,
            s3Key,
            originalSize: imageBuffer.length,
            processedSize: processedBuffer.length,
            width,
            height,
        }, 'Image processed and uploaded');

        return {
            url,
            width,
            height,
            sizeBytes: processedBuffer.length,
        };

    } catch (error) {
        logger.error({ error, filename }, 'Failed to process image');
        throw error;
    }
}

export async function downloadImage(url: string): Promise<Buffer> {
    try {
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentLength = response.headers.get('content-length');
        const maxSize = parseInt(process.env.IMAGE_MAX_MB || '10') * 1024 * 1024;

        if (contentLength && parseInt(contentLength) > maxSize) {
            throw new Error(`Image too large: ${contentLength} bytes`);
        }

        const buffer = await response.arrayBuffer();
        return Buffer.from(buffer);

    } catch (error) {
        logger.error({ error, url }, 'Failed to download image');
        throw error;
    }
}

export function isImageUrl(url: string): boolean {
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i;
    const urlPath = url.split('?')[0]; // Remove query parameters
    return urlPath ? imageExtensions.test(urlPath) : false;
}

export function validateImageConfig(): void {
    const required = ['S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

    for (const env of required) {
        if (!process.env[env]) {
            throw new Error(`Missing required environment variable: ${env}`);
        }
    }

    const maxMB = parseInt(process.env.IMAGE_MAX_MB || '10');
    const maxW = parseInt(process.env.IMAGE_MAX_W || '1920');
    const maxH = parseInt(process.env.IMAGE_MAX_H || '1080');

    if (maxMB <= 0 || maxMB > 100) {
        throw new Error('IMAGE_MAX_MB must be between 1 and 100');
    }

    if (maxW <= 0 || maxW > 4096) {
        throw new Error('IMAGE_MAX_W must be between 1 and 4096');
    }

    if (maxH <= 0 || maxH > 4096) {
        throw new Error('IMAGE_MAX_H must be between 1 and 4096');
    }
}
