// ponytail: scratch tool for regenerating packages/core/src/data/actionableCalibration.fixture.json,
// not part of the deployed worker. Run via:
//   npx wrangler dev -c scripts/wrangler.embed.toml
// then POST { "texts": string[] } to it and save the response.

export default {
  async fetch(request: Request, env: { AI: Ai }): Promise<Response> {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    const model = new URL(request.url).searchParams.get('model') ?? '@cf/baai/bge-large-en-v1.5';
    const { texts } = await request.json() as { texts: string[] };
    const result = await env.AI.run(model as keyof AiModels, { text: texts } as never);
    return Response.json(result);
  },
};
