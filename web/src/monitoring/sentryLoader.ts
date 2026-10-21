// The only module that imports the Sentry SDK, and it is only ever imported dynamically (monitoring/index.ts): the build puts it in its own chunk, `sentryLoader-*.js`, which is
// downloaded when the server has a DSN and never otherwise. scripts/check-bundle-size.mjs gives that chunk its own budget.
export { init, captureException, setTag } from '@sentry/react';
