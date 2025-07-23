import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ url }) => {
  const query = url.searchParams.get('q');
  
  if (!query) {
    return new Response(JSON.stringify({ error: 'Query parameter required' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // Basic response for now - can be enhanced later
  return new Response(JSON.stringify({ 
    query,
    results: [],
    message: 'Search functionality not yet implemented' 
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
};