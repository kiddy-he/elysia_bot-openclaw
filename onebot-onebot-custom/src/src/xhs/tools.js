import { schemas } from './schemas.js';
const definitions = {
  search: ['xhs_search_posts', 'Search public Xiaohongshu notes by keyword or a topic/tag query. Tag mode uses the site keyword endpoint and reports that exact topic filtering is unverified.'],
  inspect: ['xhs_inspect_posts', 'Read note text, author, tags, media metadata and observed interaction counts.'],
  comments: ['xhs_read_comments', 'Read a bounded page of top level comments or replies. Returns an opaque continuation cursor scoped to this request.'],
  profile: ['xhs_get_profile', 'Read a public creator profile and optionally one bounded page of posted notes.'],
  list_images: ['xhs_list_images', 'List scoped image handles for a note without exposing signed CDN URLs to the model.'],
  download_images: ['xhs_download_images', 'Queue bounded image downloads and return scoped artifact jobs.'],
  download_video: ['xhs_download_video', 'Queue a bounded native MP4 download when the note exposes a compatible stream.'],
  job_status: ['xhs_job_status', 'Read a download job owned by this request scope.'],
  cancel_job: ['xhs_cancel_job', 'Cancel a queued or running download job owned by this request scope.'],
  artifact: ['xhs_read_artifact', 'Read and integrity-check a completed local artifact owned by this request scope.'],
};
export function createTools(service, { getContext }) {
  if (typeof getContext !== 'function') throw new TypeError('getContext is required');
  return Object.entries(definitions).map(([operation, [name, description]]) => ({
    name, description, parameters: schemas[operation],
    async execute(callId, params, signal) {
      const context = await getContext({ callId, operation });
      const result = await service.execute(operation, params, context, { callId, signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, isError: !result.ok };
    },
  }));
}
export const toolDefinitions = definitions;
