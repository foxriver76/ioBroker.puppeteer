import { dirname, join } from 'node:path';
import { tests } from '@iobroker/testing';
import { fileURLToPath } from 'node:url';

// Validate the package files
tests.packageFiles(join(dirname(fileURLToPath(import.meta.url)), '..'));
