import { Xhshow } from '@ikenxuan/xhshow-ts';
import { apiRequestTarget } from './request-target.js';

// Version 1.2.0 only escapes '=' in GET signing input. Override that narrow
// serialization seam so x3, x5 and the SSK proof all cover the actual URL.
export class ApiSigner extends Xhshow {
  buildContentString(method, uri, payload = null) {
    return method.toUpperCase() === 'GET' ? apiRequestTarget(uri, payload) : super.buildContentString(method, uri, payload);
  }
}
