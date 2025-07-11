/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import Path from 'path';
import fs from 'fs/promises';
import { SemVer } from 'semver';

import { defaultsDeep } from 'lodash';
import { BehaviorSubject, firstValueFrom, map } from 'rxjs';
import { ConfigService, Env, BuildFlavor } from '@kbn/config';
import { getEnvOptions } from '@kbn/config-mocks';
import { REPO_ROOT } from '@kbn/repo-info';
import { KibanaMigrator } from '@kbn/core-saved-objects-migration-server-internal';
import {
  SavedObjectConfig,
  type SavedObjectsConfigType,
  type SavedObjectsMigrationConfigType,
  SavedObjectTypeRegistry,
  type IKibanaMigrator,
  type MigrationResult,
  type IndexTypesMap,
} from '@kbn/core-saved-objects-base-server-internal';
import { SavedObjectsRepository } from '@kbn/core-saved-objects-api-server-internal';
import {
  ElasticsearchConfig,
  type ElasticsearchConfigType,
  getCapabilitiesFromClient,
} from '@kbn/core-elasticsearch-server-internal';
import { AgentManager, configureClient } from '@kbn/core-elasticsearch-client-server-internal';
import { type LoggingConfigType, LoggingSystem } from '@kbn/core-logging-server-internal';

import {
  ALL_SAVED_OBJECT_INDICES,
  ISavedObjectTypeRegistry,
  SavedObjectsType,
} from '@kbn/core-saved-objects-server';
import { esTestConfig, kibanaServerTestUser } from '@kbn/test';
import type { LoggerFactory } from '@kbn/logging';
import { createRootWithCorePlugins, createTestServers } from '@kbn/core-test-helpers-kbn-server';
import type { ElasticsearchClient } from '@kbn/core-elasticsearch-server';
import { registerServiceConfig } from '@kbn/core-root-server-internal';
import type { ISavedObjectsRepository } from '@kbn/core-saved-objects-api-server';
import { getDocLinks, getDocLinksMeta } from '@kbn/doc-links';
import type { DocLinksServiceStart } from '@kbn/core-doc-links-server';
import type { NodeRoles } from '@kbn/core-node-server';
import { delay } from './test_utils';
import type { ElasticsearchClientWrapperFactory } from './elasticsearch_client_wrapper';

export const defaultLogFilePath = Path.join(__dirname, 'kibana_migrator_test_kit.log');

const env = Env.createDefault(REPO_ROOT, getEnvOptions());
// Extract current stack version from Env, to use as a default
export const currentVersion = env.packageInfo.version;
export const nextMinor = new SemVer(currentVersion).inc('minor').format();
export const currentBranch = env.packageInfo.branch;
export const defaultKibanaIndex = '.kibana_migrator';
export const defaultKibanaTaskIndex = `${defaultKibanaIndex}_tasks`;
export const defaultNodeRoles: NodeRoles = { migrator: true, ui: true, backgroundTasks: true };

export interface GetEsClientParams {
  settings?: Record<string, any>;
  kibanaVersion?: string;
  logFilePath?: string;
}

export interface KibanaMigratorTestKitParams {
  kibanaIndex?: string;
  kibanaVersion?: string;
  kibanaBranch?: string;
  nodeRoles?: NodeRoles;
  settings?: Record<string, any>;
  types?: Array<SavedObjectsType<any>>;
  removedTypes?: string[];
  defaultIndexTypesMap?: IndexTypesMap;
  hashToVersionMap?: Record<string, string>;
  logFilePath?: string;
  clientWrapperFactory?: ElasticsearchClientWrapperFactory;
}

export interface KibanaMigratorTestKit {
  client: ElasticsearchClient;
  migrator: IKibanaMigrator;
  runMigrations: () => Promise<MigrationResult[]>;
  typeRegistry: ISavedObjectTypeRegistry;
  savedObjectsRepository: ISavedObjectsRepository;
}

export const startElasticsearch = async ({
  esVersion,
  basePath,
  dataArchive,
  timeout = 60000,
}: {
  esVersion?: string;
  basePath?: string;
  dataArchive?: string;
  timeout?: number;
} = {}) => {
  const { startES } = createTestServers({
    adjustTimeout: (t: number) => jest.setTimeout(t + (timeout ?? 0)),
    settings: {
      es: {
        license: 'basic',
        basePath,
        dataArchive,
        esVersion,
      },
    },
  });
  return await startES();
};

export const getEsClient = async ({
  settings = {},
  kibanaVersion = currentVersion,
  logFilePath = defaultLogFilePath,
}: GetEsClientParams = {}) => {
  const loggingSystem = new LoggingSystem();
  const loggerFactory = loggingSystem.asLoggerFactory();

  const configService = getConfigService(settings, loggerFactory, logFilePath);

  // configure logging system
  const loggingConf = await firstValueFrom(configService.atPath<LoggingConfigType>('logging'));
  await loggingSystem.upgrade(loggingConf);

  return await getElasticsearchClient(configService, loggerFactory, kibanaVersion);
};

export const getKibanaMigratorTestKit = async ({
  settings = {},
  kibanaIndex = defaultKibanaIndex,
  defaultIndexTypesMap = {}, // do NOT assume any types are stored in any index by default
  hashToVersionMap = {}, // allows testing the md5 => modelVersion transition
  kibanaVersion = currentVersion,
  kibanaBranch = currentBranch,
  types = [],
  removedTypes = [],
  logFilePath = defaultLogFilePath,
  nodeRoles = defaultNodeRoles,
  clientWrapperFactory,
}: KibanaMigratorTestKitParams = {}): Promise<KibanaMigratorTestKit> => {
  let hasRun = false;
  const loggingSystem = new LoggingSystem();
  const loggerFactory = loggingSystem.asLoggerFactory();

  const configService = getConfigService(settings, loggerFactory, logFilePath);

  // configure logging system
  const loggingConf = await firstValueFrom(configService.atPath<LoggingConfigType>('logging'));
  await loggingSystem.upgrade(loggingConf);

  const rawClient = await getElasticsearchClient(configService, loggerFactory, kibanaVersion);
  const client = clientWrapperFactory ? clientWrapperFactory(rawClient) : rawClient;

  const typeRegistry = new SavedObjectTypeRegistry({ legacyTypes: removedTypes });

  // types must be registered before instantiating the migrator
  registerTypes(typeRegistry, types);

  const migrator = await getMigrator({
    configService,
    client,
    typeRegistry,
    loggerFactory,
    kibanaIndex,
    defaultIndexTypesMap,
    hashToVersionMap,
    kibanaVersion,
    kibanaBranch,
    nodeRoles,
  });

  const runMigrations = async () => {
    if (hasRun) {
      throw new Error('The test kit migrator can only be run once. Please instantiate it again.');
    }
    hasRun = true;
    migrator.prepareMigrations();
    try {
      return await migrator.runMigrations();
    } finally {
      await loggingSystem.stop();
    }
  };

  const savedObjectsRepository = SavedObjectsRepository.createRepository(
    migrator,
    typeRegistry,
    kibanaIndex,
    client,
    loggerFactory.get('saved_objects')
  );

  return {
    client,
    migrator,
    runMigrations,
    typeRegistry,
    savedObjectsRepository,
  };
};

const getConfigService = (
  settings: Record<string, any>,
  loggerFactory: LoggerFactory,
  logFilePath: string
) => {
  // Define some basic default kibana settings
  const DEFAULTS_SETTINGS = {
    server: {
      autoListen: true,
      // Use the ephemeral port to make sure that tests use the first available
      // port and aren't affected by the timing issues in test environment.
      port: 0,
      xsrf: { disableProtection: true },
    },
    elasticsearch: {
      hosts: [esTestConfig.getUrl()],
      username: kibanaServerTestUser.username,
      password: kibanaServerTestUser.password,
    },
    logging: {
      appenders: {
        file: {
          type: 'file',
          fileName: logFilePath,
          layout: {
            type: 'json',
          },
        },
      },
      loggers: [
        {
          name: 'root',
          level: 'info',
          appenders: ['file'],
        },
      ],
    },
    plugins: {},
    migrations: { skip: false },
  };

  const rawConfigProvider = {
    getConfig$: () => new BehaviorSubject(defaultsDeep({}, settings, DEFAULTS_SETTINGS)),
  };

  const configService = new ConfigService(rawConfigProvider, env, loggerFactory);
  registerServiceConfig(configService);
  return configService;
};

const getElasticsearchClient = async (
  configService: ConfigService,
  loggerFactory: LoggerFactory,
  kibanaVersion: string
) => {
  const esClientConfig = await firstValueFrom(
    configService
      .atPath<ElasticsearchConfigType>('elasticsearch')
      .pipe(map((rawConfig) => new ElasticsearchConfig(rawConfig)))
  );

  return configureClient(esClientConfig, {
    logger: loggerFactory.get('elasticsearch'),
    type: 'data',
    agentFactoryProvider: new AgentManager(
      loggerFactory.get('elasticsearch-service', 'agent-manager'),
      { dnsCacheTtlInSeconds: esClientConfig.dnsCacheTtl?.asSeconds() ?? 0 }
    ),
    kibanaVersion,
  });
};

interface GetMigratorParams {
  configService: ConfigService;
  client: ElasticsearchClient;
  kibanaIndex: string;
  typeRegistry: ISavedObjectTypeRegistry;
  defaultIndexTypesMap: IndexTypesMap;
  hashToVersionMap: Record<string, string>;
  loggerFactory: LoggerFactory;
  kibanaVersion: string;
  kibanaBranch: string;
  buildFlavor?: BuildFlavor;
  nodeRoles: NodeRoles;
  kibanaVersionCheck?: string;
}

const getMigrator = async ({
  configService,
  client,
  kibanaIndex,
  typeRegistry,
  defaultIndexTypesMap,
  hashToVersionMap,
  loggerFactory,
  kibanaVersion,
  kibanaBranch,
  buildFlavor = 'traditional',
  nodeRoles,
  kibanaVersionCheck = '8.18.0',
}: GetMigratorParams) => {
  const savedObjectsConf = await firstValueFrom(
    configService.atPath<SavedObjectsConfigType>('savedObjects')
  );
  const savedObjectsMigrationConf = await firstValueFrom(
    configService.atPath<SavedObjectsMigrationConfigType>('migrations')
  );
  const soConfig = new SavedObjectConfig(savedObjectsConf, savedObjectsMigrationConf);

  const docLinks: DocLinksServiceStart = {
    ...getDocLinksMeta({ kibanaBranch, buildFlavor }),
    links: getDocLinks({ kibanaBranch, buildFlavor }),
  };

  const esCapabilities = await getCapabilitiesFromClient(client);

  return new KibanaMigrator({
    client,
    kibanaIndex,
    typeRegistry,
    defaultIndexTypesMap,
    hashToVersionMap,
    soMigrationsConfig: soConfig.migration,
    kibanaVersion,
    logger: loggerFactory.get('savedobjects-service'),
    docLinks,
    waitForMigrationCompletion: false, // ensure we have an active role in the migration
    nodeRoles,
    esCapabilities,
    kibanaVersionCheck,
  });
};

export const deleteSavedObjectIndices = async (
  client: ElasticsearchClient,
  index: string[] = ALL_SAVED_OBJECT_INDICES
) => {
  const res = await client.indices.get({ index, ignore_unavailable: true }, { ignore: [404] });
  const indices = Object.keys(res);
  if (!indices.length) {
    return [];
  }
  return await client.indices.delete(
    { index: indices, ignore_unavailable: true },
    { ignore: [404] }
  );
};

export const getAggregatedTypesCount = async (
  client: ElasticsearchClient,
  index: string | string[] = [defaultKibanaIndex, defaultKibanaTaskIndex]
): Promise<Record<string, number>> => {
  try {
    await client.indices.refresh({ index });
    const response = await client.search<unknown, { typesAggregation: { buckets: any[] } }>({
      index,
      _source: false,
      aggs: {
        typesAggregation: {
          terms: {
            // assign type __UNKNOWN__ to those documents that don't define one
            missing: '__UNKNOWN__',
            field: 'type',
            size: 100,
          },
          aggs: {
            docs: {
              top_hits: {
                size: 10,
                _source: {
                  excludes: ['*'],
                },
              },
            },
          },
        },
      },
    });

    return (response.aggregations!.typesAggregation.buckets as unknown as any).reduce(
      (acc: any, current: any) => {
        acc[current.key] = current.doc_count;
        return acc;
      },
      {}
    );
  } catch (error) {
    if (error.meta?.statusCode === 404) {
      return {};
    }
    throw error;
  }
};

const registerTypes = (
  typeRegistry: SavedObjectTypeRegistry,
  types?: Array<SavedObjectsType<any>>
) => {
  (types || []).forEach((type) => typeRegistry.registerType(type));
};

export const getCurrentVersionTypeRegistry = async ({
  oss,
}: {
  oss: boolean;
}): Promise<ISavedObjectTypeRegistry> => {
  const root = createRootWithCorePlugins({}, { oss });
  await root.preboot();
  const coreSetup = await root.setup();
  const typeRegistry = coreSetup.savedObjects.getTypeRegistry();
  void root.shutdown(); // do not await for it, or we might block the tests
  return typeRegistry;
};

export const overrideTypeRegistry = (
  typeRegistry: ISavedObjectTypeRegistry,
  transform: (type: SavedObjectsType<any>) => SavedObjectsType<any>
): ISavedObjectTypeRegistry => {
  const updatedTypeRegistry = new SavedObjectTypeRegistry();
  typeRegistry.getAllTypes().forEach((type) => updatedTypeRegistry.registerType(transform(type)));
  return updatedTypeRegistry;
};

export const readLog = async (logFilePath: string = defaultLogFilePath): Promise<string> => {
  await delay(0.1);
  return await fs.readFile(logFilePath, 'utf-8');
};

export const clearLog = async (logFilePath: string = defaultLogFilePath): Promise<void> => {
  await fs.truncate(logFilePath).catch(() => {});
};
