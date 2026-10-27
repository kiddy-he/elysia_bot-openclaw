import Ajv from 'ajv';
import { fail } from './errors.js';
const str = maxLength => ({ type: 'string', minLength: 1, maxLength });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const target = { ref_id: str(2000) };
const quality = { type: 'string', enum: ['best_available', 'original_only'] };
const constraints = obj({
  published_after: str(80), published_before: str(80), author_id: str(128),
});
export const schemas = {
  search: obj({ query: str(120), limit: { type: 'integer', minimum: 1, maximum: 12 }, sort: { enum: ['relevance', 'latest'] }, media_type: { enum: ['image', 'video'] }, search_mode: { enum: ['keyword', 'tag'] } }, ['query']),
  inspect: obj({ ref_ids: { type: 'array', minItems: 1, maxItems: 6, items: str(2000), uniqueItems: true } }, ['ref_ids']),
  comments: obj({ ref_id: str(2000), cursor: { type: 'string', maxLength: 512 }, parent_comment_id: { type: 'string', minLength: 1, maxLength: 128 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['ref_id']),
  profile: obj({ user_id: str(128), include_posts: { type: 'boolean' }, posts_limit: { type: 'integer', minimum: 1, maximum: 20 }, posts_cursor: { type: 'string', maxLength: 512 } }, ['user_id']),
  list_images: obj({ ...target, offset: { type: 'integer', minimum: 0, maximum: 159 } }, ['ref_id']),
  download_images: obj({ image_ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: str(64) }, quality, constraints }, ['image_ids']),
  download_video: obj({ ...target, quality, constraints }, ['ref_id']),
  job_status: obj({ job_id: str(64) }, ['job_id']),
  cancel_job: obj({ job_id: str(64) }, ['job_id']),
  artifact: obj({ artifact_id: str(64) }, ['artifact_id']),
  login: obj({}), status: obj({}),
};
const ajv = new Ajv({ allErrors: false, strict: false });
const compiled = new Map(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));
export function validate(operation, params) {
  if (!compiled.has(operation)) fail('invalid_operation');
  if (!compiled.get(operation)(params)) fail('invalid_request');
  return structuredClone(params);
}
