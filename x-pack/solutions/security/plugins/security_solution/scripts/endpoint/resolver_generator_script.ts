/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/* eslint-disable no-console,max-classes-per-file */
import yargs from 'yargs';
import fs from 'fs';
import { Client, errors, HttpConnection } from '@elastic/elasticsearch';
import type { ClientOptions } from '@elastic/elasticsearch/lib/client';
import { CA_CERT_PATH } from '@kbn/dev-utils';
import type { ToolingLog } from '@kbn/tooling-log';
import type { KbnClientOptions } from '@kbn/test';
import { KbnClient } from '@kbn/test';
import { isServerlessKibanaFlavor } from '../../common/endpoint/utils/kibana_status';
import { createToolingLogger } from '../../common/endpoint/data_loaders/utils';
import { EndpointSecurityTestRolesLoader } from './common/role_and_user_loader';
import { METADATA_DATASTREAM } from '../../common/endpoint/constants';
import { EndpointMetadataGenerator } from '../../common/endpoint/data_generators/endpoint_metadata_generator';
import { indexHostsAndAlerts } from '../../common/endpoint/index_data';
import { ANCESTRY_LIMIT, EndpointDocGenerator } from '../../common/endpoint/generate_data';
import { fetchStackVersion } from './common/stack_services';
import { ENDPOINT_ALERTS_INDEX, ENDPOINT_EVENTS_INDEX } from './common/constants';

main();

function handleErr(err: unknown) {
  if (err instanceof errors.ResponseError && err.statusCode !== 404) {
    console.log(JSON.stringify(err, null, 2));
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
}

async function deleteIndices(indices: string[], client: Client) {
  for (const index of indices) {
    try {
      // The index could be a data stream so let's try deleting that first
      // The ES client in Kibana doesn't support data streams yet so we need to make a raw request to the ES route
      await client.transport.request({ method: 'DELETE', path: `_data_stream/${index}` });
    } catch (err) {
      handleErr(err);
    }
  }
}

interface UserInfo {
  username: string;
  password: string;
  full_name?: string;
  roles?: string[];
}

async function addUser(esClient: Client, user?: UserInfo): Promise<UserInfo | undefined> {
  if (!user) {
    return;
  }

  const superuserRole = ['superuser', 'kibana_system'];
  const path = `_security/user/${user.username}`;
  // add user if doesn't exist already
  try {
    console.log(`Adding ${user.username}...`);
    const addedUser = await esClient.transport.request<Promise<{ created: boolean }>>({
      method: 'POST',
      path,
      body: {
        password: user.password,
        roles: user.roles ?? superuserRole,
        full_name: user.full_name ?? user.username,
        username: user.username,
      },
    });
    if (addedUser.created) {
      console.log(`User ${user.username} added successfully!`);
    } else {
      console.log(`User ${user.username} already exists!`);
    }
    return {
      username: user.username,
      password: user.password,
    };
  } catch (error) {
    handleErr(error);
  }
}

async function deleteUser(esClient: Client, username: string): Promise<{ found: boolean }> {
  return esClient.transport.request({
    method: 'DELETE',
    path: `_security/user/${username}`,
  });
}

function updateURL({
  url,
  user,
  protocol,
}: {
  url: string;
  user?: { username: string; password: string };
  protocol?: string;
}): string {
  const urlObject = new URL(url);
  if (user) {
    urlObject.username = user.username;
    urlObject.password = user.password;
  }
  if (protocol) {
    urlObject.protocol = protocol;
  }
  return urlObject.href;
}

async function main() {
  const startTime = new Date().getTime();

  const argv = yargs.help().options({
    seed: {
      alias: 's',
      describe: 'random seed to use for document generator',
      type: 'string',
    },
    node: {
      alias: 'n',
      describe: 'elasticsearch node url',
      default: 'http://elastic:changeme@127.0.0.1:9200',
      type: 'string',
    },
    kibana: {
      alias: 'k',
      describe: 'kibana url',
      default: 'http://elastic:changeme@127.0.0.1:5601',
      type: 'string',
    },
    eventIndex: {
      alias: 'ei',
      describe: 'index to store events in',
      default: ENDPOINT_EVENTS_INDEX,
      type: 'string',
    },
    alertIndex: {
      alias: 'ai',
      describe: 'index to store alerts in',
      default: ENDPOINT_ALERTS_INDEX,
      type: 'string',
    },
    metadataIndex: {
      alias: 'mi',
      describe: 'index to store host metadata in',
      default: METADATA_DATASTREAM,
      type: 'string',
    },
    policyIndex: {
      alias: 'pi',
      describe: 'index to store host policy in',
      default: 'metrics-endpoint.policy-default',
      type: 'string',
    },
    ancestors: {
      alias: 'anc',
      describe: 'number of ancestors of origin to create',
      type: 'number',
      default: 3,
    },
    ancestryArraySize: {
      alias: 'ancSize',
      describe: 'the upper bound size of the ancestry array, 0 will mark the field as undefined',
      type: 'number',
      default: ANCESTRY_LIMIT,
    },
    generations: {
      alias: 'gen',
      describe: 'number of child generations to create',
      type: 'number',
      default: 3,
    },
    children: {
      alias: 'ch',
      describe: 'maximum number of children per node',
      type: 'number',
      default: 3,
    },
    relatedEvents: {
      alias: 'related',
      describe: 'number of related events to create for each process event',
      type: 'number',
      default: 5,
    },
    relatedAlerts: {
      alias: 'relAlerts',
      describe: 'number of related alerts to create for each process event',
      type: 'number',
      default: 5,
    },
    percentWithRelated: {
      alias: 'pr',
      describe: 'percent of process events to add related events and related alerts to',
      type: 'number',
      default: 30,
    },
    percentTerminated: {
      alias: 'pt',
      describe: 'percent of process events to add termination event for',
      type: 'number',
      default: 30,
    },
    maxChildrenPerNode: {
      alias: 'maxCh',
      describe:
        'always generate the max number of children per node instead of it being random up to the max children',
      type: 'boolean',
      default: false,
    },
    numHosts: {
      alias: 'ne',
      describe: 'number of different hosts to generate alerts for',
      type: 'number',
      default: 1,
    },
    numDocs: {
      alias: 'nd',
      describe: 'number of metadata and policy response doc to generate per host',
      type: 'number',
      default: 5,
    },
    alertsPerHost: {
      alias: 'ape',
      describe: 'number of resolver trees to make for each host',
      type: 'number',
      default: 1,
    },
    delete: {
      alias: 'd',
      describe: 'delete indices and remake them',
      type: 'boolean',
      default: false,
    },
    fleet: {
      alias: 'f',
      describe: 'enroll fleet agents for hosts',
      type: 'boolean',
      default: false,
    },
    ssl: {
      alias: 'ssl',
      describe: 'Use https for elasticsearch and kbn clients',
      type: 'boolean',
      default: false,
    },
    withNewUser: {
      alias: 'wnu',
      describe:
        'If the --fleet flag is enabled, using `--withNewUser=username:password` would add a new user with \
         the given username, password and `superuser`, `kibana_system` roles. Adding a new user would also write \
        to indices in the generator as this user with the new roles.',
      type: 'string',
      default: '',
    },
    randomVersions: {
      describe:
        'By default, the data generated (that contains a stack version - ex: `agent.version`) will have a ' +
        'version number set to be the same as the version of the running stack. Using this flag (`--randomVersions=true`) ' +
        'will result in random version being generated',
      default: false,
    },
    rbacUser: {
      alias: 'rbac',
      describe:
        'Creates a set of roles and users, password=changeme, with RBAC privileges enabled/disabled. Neither have the superuser role. ',
      type: 'boolean',
      default: false,
    },
  }).argv;

  let ca: Buffer;
  let clientOptions: ClientOptions = {
    Connection: HttpConnection,
    requestTimeout: 30_000,
  };
  let url: string;
  let node: string;
  const logger = createToolingLogger();
  const toolingLogOptions = { log: logger };

  let kbnClientOptions: KbnClientOptions = {
    ...toolingLogOptions,
    url: argv.kibana,
  };

  if (argv.ssl) {
    ca = fs.readFileSync(CA_CERT_PATH);
    url = updateURL({ url: argv.kibana, protocol: 'https:' });
    node = updateURL({ url: argv.node, protocol: 'https:' });
    kbnClientOptions = {
      ...kbnClientOptions,
      url,
      certificateAuthorities: [ca],
    };

    clientOptions = { ...clientOptions, node, tls: { ca: [ca] } };
  } else {
    clientOptions = { ...clientOptions, node: argv.node };
  }
  let client = new Client(clientOptions);
  let kbnClient = new KbnClient({ ...kbnClientOptions });
  let user: UserInfo | undefined;
  const isServerless = await isServerlessKibanaFlavor(kbnClient);

  logger.info(`Build flavor: ${isServerless ? 'serverless' : 'non-serverless'}`);

  if (argv.fleet && !argv.withNewUser && !isServerless) {
    // warn and exit when using fleet flag
    logger.error(
      'Please use the --withNewUser=username:password flag to add a custom user with required roles when --fleet is enabled!'
    );
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  }

  // if fleet flag is used
  if (argv.fleet) {
    if (!isServerless) {
      // add endpoint user if --withNewUser flag has values as username:password
      const newUserCreds =
        argv.withNewUser.indexOf(':') !== -1 ? argv.withNewUser.split(':') : undefined;
      user = await addUser(
        client,
        newUserCreds
          ? {
              username: newUserCreds[0],
              password: newUserCreds[1],
            }
          : undefined
      );

      // update client and kibana options before instantiating
      if (user) {
        // use endpoint user for Es and Kibana URLs

        url = updateURL({ url: argv.kibana, user });
        node = updateURL({ url: argv.node, user });

        kbnClientOptions = {
          ...kbnClientOptions,
          url,
        };

        client = new Client({ ...clientOptions, node });
        kbnClient = new KbnClient({ ...kbnClientOptions });

        logger.verbose(`ES/KBN clients updated to login using: ${JSON.stringify(user)}`);
      }
    } else {
      logger.warning(
        'Option `--withNewUser` not supported in serverless.\n' +
          'Ensure that `--kibana` and `--node` options are defined with username/password of ' +
          '`system_indices_superuser:changeme`'
      );
    }
  }

  if (argv.delete) {
    await deleteIndices(
      [argv.eventIndex, argv.metadataIndex, argv.policyIndex, argv.alertIndex],
      client
    );
  }

  if (argv.rbacUser) {
    if (isServerless) {
      // FIXME:PT create users in serverless when that capability is available

      throw new Error(`Can not use '--rbacUser' option against serverless deployment`);
    }

    await loadRbacTestUsers(kbnClient, logger);
  }

  const seed = argv.seed || Math.random().toString();
  let DocGenerator: typeof EndpointDocGenerator = EndpointDocGenerator;

  // If `--randomVersions` is NOT set, then use custom generator that ensures all data generated
  // has a stack version number that matches that of the running stack
  if (!argv.randomVersions) {
    const stackVersion = await fetchStackVersion(kbnClient);

    // Document Generator override that uses a custom Endpoint Metadata generator and sets the
    // `agent.version` to the current version
    DocGenerator = class extends EndpointDocGenerator {
      constructor(...args: ConstructorParameters<typeof EndpointDocGenerator>) {
        const MetadataGenerator = class extends EndpointMetadataGenerator {
          protected randomVersion(): string {
            return stackVersion;
          }
        };

        super(args[0], MetadataGenerator);
      }
    };
  }

  logger.info('Indexing host and alerts...');
  await indexHostsAndAlerts(
    client,
    kbnClient,
    seed,
    argv.numHosts,
    argv.numDocs,
    argv.metadataIndex,
    argv.policyIndex,
    argv.eventIndex,
    argv.alertIndex,
    argv.alertsPerHost,
    argv.fleet,
    {
      ancestors: argv.ancestors,
      generations: argv.generations,
      children: argv.children,
      relatedEvents: argv.relatedEvents,
      relatedAlerts: argv.relatedAlerts,
      percentWithRelated: argv.percentWithRelated,
      percentTerminated: argv.percentTerminated,
      alwaysGenMaxChildrenPerNode: argv.maxChildrenPerNode,
      ancestryArraySize: argv.ancestryArraySize,
      eventsDataStream: EndpointDocGenerator.createDataStreamFromIndex(argv.eventIndex),
      alertsDataStream: EndpointDocGenerator.createDataStreamFromIndex(argv.alertIndex),
    },
    DocGenerator
  );

  // delete endpoint_user after
  if (user && !isServerless) {
    const deleted = await deleteUser(client, user.username);
    if (deleted.found) {
      logger.info(`User ${user.username} deleted successfully!`);
    }
  }

  logger.info(`Creating and indexing documents took: ${new Date().getTime() - startTime}ms`);
}

const loadRbacTestUsers = async (kbnClient: KbnClient, logger: ToolingLog): Promise<void> => {
  const loadedRoles = await new EndpointSecurityTestRolesLoader(kbnClient, logger).loadAll();

  logger.info(`Roles and associated users loaded. Login accounts:
  ${Object.values(loadedRoles)
    .map(({ username, password }) => `${username} / ${password}`)
    .join('\n  ')}`);
};
