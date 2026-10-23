import { z } from 'zod';

export const liveProviderConfigurationsAvailableSchema = z.enum(['true', 'false']).default('false').transform(value => value === 'true');
