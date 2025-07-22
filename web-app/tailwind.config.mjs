/** @type {import('tailwindcss').Config} */
export default {
    content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
    theme: {
        extend: {
            colors: {
                'stack-orange': '#f48225',
                'stack-blue': '#0077cc',
                'stack-gray': {
                    50: '#fafafb',
                    100: '#f2f2f3',
                    200: '#e4e6ea',
                    300: '#d6d9dc',
                    400: '#bbc0c4',
                    500: '#9fa6ad',
                    600: '#6a737c',
                    700: '#535a60',
                    800: '#3d4147',
                    900: '#2d2d30'
                }
            },
            fontFamily: {
                'sans': ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'sans-serif']
            }
        },
    },
    plugins: [],
}
