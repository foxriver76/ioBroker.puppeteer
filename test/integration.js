import { tests } from '@iobroker/testing';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(join(dirname(fileURLToPath(import.meta.url)), '..'));
