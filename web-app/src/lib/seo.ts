export interface SEOData {
    title: string;
    description: string;
    keywords?: string[];
    canonical?: string;
    ogType?: string;
    ogImage?: string;
}

export function generateStructuredData(data: {
    type: 'WebSite' | 'BreadcrumbList' | 'DiscussionForumPosting' | 'QAPage';
    name?: string;
    url?: string;
    description?: string;
    breadcrumbs?: Array<{ name: string; url: string }>;
    author?: string;
    dateCreated?: Date;
    dateModified?: Date;
    answerCount?: number;
}) {
    const baseSchema = {
        '@context': 'https://schema.org',
        '@type': data.type
    };

    switch (data.type) {
        case 'WebSite':
            return {
                ...baseSchema,
                name: data.name,
                url: data.url,
                description: data.description,
                potentialAction: {
                    '@type': 'SearchAction',
                    target: {
                        '@type': 'EntryPoint',
                        urlTemplate: `${data.url}/forum?q={search_term_string}`
                    },
                    'query-input': 'required name=search_term_string'
                }
            };

        case 'BreadcrumbList':
            return {
                ...baseSchema,
                itemListElement: data.breadcrumbs?.map((item, index) => ({
                    '@type': 'ListItem',
                    position: index + 1,
                    name: item.name,
                    item: item.url
                }))
            };

        case 'DiscussionForumPosting':
            return {
                ...baseSchema,
                headline: data.name,
                author: {
                    '@type': 'Person',
                    name: data.author
                },
                datePublished: data.dateCreated?.toISOString(),
                dateModified: data.dateModified?.toISOString(),
                interactionStatistic: {
                    '@type': 'InteractionCounter',
                    interactionType: 'https://schema.org/CommentAction',
                    userInteractionCount: data.answerCount || 0
                }
            };

        case 'QAPage':
            return {
                ...baseSchema,
                mainEntity: {
                    '@type': 'Question',
                    name: data.name,
                    author: {
                        '@type': 'Person',
                        name: data.author
                    },
                    dateCreated: data.dateCreated?.toISOString(),
                    answerCount: data.answerCount || 0
                }
            };

        default:
            return baseSchema;
    }
}

export function sanitizeForSEO(text: string, maxLength: number = 160): string {
    // Remove HTML tags
    const cleaned = text.replace(/<[^>]*>/g, '');

    // Decode HTML entities
    const decoded = cleaned
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    // Trim and limit length
    const trimmed = decoded.trim();
    if (trimmed.length <= maxLength) return trimmed;

    // Cut at word boundary
    const cut = trimmed.substring(0, maxLength);
    const lastSpace = cut.lastIndexOf(' ');

    return lastSpace > 0 ? cut.substring(0, lastSpace) + '...' : cut + '...';
}
