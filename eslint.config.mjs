import config from '@iobroker/eslint-config';

export default [
    {
        ignores: ['.dev-server/*', 'build/*']
    },
    ...config
];
