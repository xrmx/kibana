/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { IndicesPutIndexTemplateRequest } from '@elastic/elasticsearch/lib/api/types';
import { getEntityHistoryIndexTemplateV1 } from '../../common/helpers';
import {
  ENTITY_ENTITY_COMPONENT_TEMPLATE_V1,
  ENTITY_EVENT_COMPONENT_TEMPLATE_V1,
  ENTITY_HISTORY_BASE_COMPONENT_TEMPLATE_V1,
  ENTITY_HISTORY_INDEX_PREFIX_V1,
} from '../../common/constants_entities';
import { getCustomHistoryTemplateComponents } from './components/helpers';

export const getEntitiesHistoryIndexTemplateConfig = (
  definitionId: string
): IndicesPutIndexTemplateRequest => ({
  name: getEntityHistoryIndexTemplateV1(definitionId),
  _meta: {
    description:
      "Index template for indices managed by the Elastic Entity Model's entity discovery framework for the history dataset",
    ecs_version: '8.0.0',
    managed: true,
    managed_by: 'elastic_entity_model',
  },
  ignore_missing_component_templates: getCustomHistoryTemplateComponents(definitionId),
  composed_of: [
    ENTITY_HISTORY_BASE_COMPONENT_TEMPLATE_V1,
    ENTITY_ENTITY_COMPONENT_TEMPLATE_V1,
    ENTITY_EVENT_COMPONENT_TEMPLATE_V1,
    ...getCustomHistoryTemplateComponents(definitionId),
  ],
  index_patterns: [`${ENTITY_HISTORY_INDEX_PREFIX_V1}.*`],
  priority: 200,
  template: {
    mappings: {
      _meta: {
        version: '1.6.0',
      },
      date_detection: false,
      dynamic_templates: [
        {
          strings_as_keyword: {
            mapping: {
              ignore_above: 1024,
              type: 'keyword',
              fields: {
                text: {
                  type: 'text',
                },
              },
            },
            match_mapping_type: 'string',
          },
        },
        {
          entity_metrics: {
            mapping: {
              type: '{dynamic_type}',
            },
            match_mapping_type: ['long', 'double'],
            path_match: 'entity.metrics.*',
          },
        },
      ],
    },
    settings: {
      index: {
        codec: 'best_compression',
        mapping: {
          total_fields: {
            limit: 2000,
          },
        },
      },
    },
  },
});
