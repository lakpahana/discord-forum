import { Collection, Attachment } from 'discord.js';
import { downloadImage, processAndUploadImage, isImageUrl, ProcessedImage } from '../lib/image';
import { recordImageSize, measureImageProcessing } from '../lib/metrics';
import { createLogger } from '../lib/logger';

const logger = createLogger('imageHandler');

export async function processImages(attachments: Collection<string, Attachment>): Promise<ProcessedImage[]> {
    const imageAttachments = attachments.filter(attachment => {
        return attachment.contentType?.startsWith('image/') || isImageUrl(attachment.url);
    });

    if (imageAttachments.size === 0) {
        return [];
    }

    const results: ProcessedImage[] = [];

    for (const attachment of imageAttachments.values()) {
        try {
            await measureImageProcessing(async () => {
                logger.debug({
                    attachmentId: attachment.id,
                    filename: attachment.name,
                    size: attachment.size,
                    url: attachment.url,
                }, 'Processing image attachment');

                // Download the image
                const imageBuffer = await downloadImage(attachment.url);
                recordImageSize('original', imageBuffer.length);

                // Process and upload
                const processedImage = await processAndUploadImage(
                    imageBuffer,
                    attachment.name || `image_${attachment.id}`,
                    {
                        maxWidth: parseInt(process.env.IMAGE_MAX_W || '1920'),
                        maxHeight: parseInt(process.env.IMAGE_MAX_H || '1080'),
                        maxSizeBytes: parseInt(process.env.IMAGE_MAX_MB || '10') * 1024 * 1024,
                    }
                );

                recordImageSize('processed', processedImage.sizeBytes);
                results.push(processedImage);

                logger.info({
                    attachmentId: attachment.id,
                    filename: attachment.name,
                    originalSize: imageBuffer.length,
                    processedSize: processedImage.sizeBytes,
                    dimensions: `${processedImage.width}x${processedImage.height}`,
                    url: processedImage.url,
                }, 'Image processed successfully');
            });

        } catch (error) {
            logger.error({
                error,
                attachmentId: attachment.id,
                filename: attachment.name,
                url: attachment.url,
            }, 'Failed to process image attachment');

            // Continue with other images even if one fails
            continue;
        }
    }

    return results;
}

export async function processImageUrls(urls: string[]): Promise<ProcessedImage[]> {
    const results: ProcessedImage[] = [];

    for (const url of urls) {
        if (!isImageUrl(url)) {
            continue;
        }

        try {
            await measureImageProcessing(async () => {
                logger.debug({ url }, 'Processing image URL');

                // Extract filename from URL
                const filename = url.split('/').pop()?.split('?')[0] || 'image';

                // Download the image
                const imageBuffer = await downloadImage(url);
                recordImageSize('original', imageBuffer.length);

                // Process and upload
                const processedImage = await processAndUploadImage(
                    imageBuffer,
                    filename,
                    {
                        maxWidth: parseInt(process.env.IMAGE_MAX_W || '1920'),
                        maxHeight: parseInt(process.env.IMAGE_MAX_H || '1080'),
                        maxSizeBytes: parseInt(process.env.IMAGE_MAX_MB || '10') * 1024 * 1024,
                    }
                );

                recordImageSize('processed', processedImage.sizeBytes);
                results.push(processedImage);

                logger.info({
                    originalUrl: url,
                    filename,
                    originalSize: imageBuffer.length,
                    processedSize: processedImage.sizeBytes,
                    dimensions: `${processedImage.width}x${processedImage.height}`,
                    processedUrl: processedImage.url,
                }, 'Image URL processed successfully');
            });

        } catch (error) {
            logger.error({
                error,
                url,
            }, 'Failed to process image URL');

            // Continue with other images even if one fails
            continue;
        }
    }

    return results;
}
