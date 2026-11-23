// ccn への中継（lib/proxy.ts）。全部のメソッドを同じ口で通す
import { defineHandler } from 'void';
import { proxyToCcn } from '../../lib/proxy';

const handle = defineHandler((c) => proxyToCcn(c));
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
