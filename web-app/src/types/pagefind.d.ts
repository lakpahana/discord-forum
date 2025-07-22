declare module '@pagefind/default-ui' {
    interface PagefindUIOptions {
        element: string;
        showSubResults?: boolean;
        showImages?: boolean;
        excerptLength?: number;
        resetStyles?: boolean;
        placeholder?: string;
        bundlePath?: string;
    }

    export class PagefindUI {
        constructor(options: PagefindUIOptions);
    }
}
