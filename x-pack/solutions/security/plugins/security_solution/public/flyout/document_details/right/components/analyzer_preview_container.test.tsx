/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { render, screen } from '@testing-library/react';
import { TestProviders } from '../../../../common/mock';
import React from 'react';
import { DocumentDetailsContext } from '../../shared/context';
import { mockContextValue } from '../../shared/mocks/mock_context';
import { AnalyzerPreviewContainer } from './analyzer_preview_container';
import { useIsInvestigateInResolverActionEnabled } from '../../../../detections/components/alerts_table/timeline_actions/investigate_in_resolver';
import { ANALYZER_PREVIEW_TEST_ID } from './test_ids';
import { useAlertPrevalenceFromProcessTree } from '../../shared/hooks/use_alert_prevalence_from_process_tree';
import * as mock from '../mocks/mock_analyzer_data';
import {
  EXPANDABLE_PANEL_CONTENT_TEST_ID,
  EXPANDABLE_PANEL_HEADER_TITLE_ICON_TEST_ID,
  EXPANDABLE_PANEL_HEADER_TITLE_LINK_TEST_ID,
  EXPANDABLE_PANEL_HEADER_TITLE_TEXT_TEST_ID,
  EXPANDABLE_PANEL_TOGGLE_ICON_TEST_ID,
} from '../../../shared/components/test_ids';
import { useIsExperimentalFeatureEnabled } from '../../../../common/hooks/use_experimental_features';
import { useInvestigateInTimeline } from '../../../../detections/components/alerts_table/timeline_actions/use_investigate_in_timeline';

jest.mock(
  '../../../../detections/components/alerts_table/timeline_actions/investigate_in_resolver'
);
jest.mock('../../shared/hooks/use_alert_prevalence_from_process_tree');
jest.mock(
  '../../../../detections/components/alerts_table/timeline_actions/use_investigate_in_timeline'
);
jest.mock('../../../../common/hooks/use_experimental_features');

const mockNavigateToAnalyzer = jest.fn();
jest.mock('../../shared/hooks/use_navigate_to_analyzer', () => {
  return { useNavigateToAnalyzer: () => ({ navigateToAnalyzer: mockNavigateToAnalyzer }) };
});

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return { ...actual, useLocation: jest.fn().mockReturnValue({ pathname: '' }) };
});
jest.mock('react-redux', () => {
  const original = jest.requireActual('react-redux');

  return {
    ...original,
    useDispatch: () => jest.fn(),
  };
});

const NO_ANALYZER_MESSAGE =
  'You can only visualize events triggered by hosts configured with the Elastic Defend integration or any sysmon data from winlogbeat. Refer to Visual event analyzer(external, opens in a new tab or window) for more information.';

const renderAnalyzerPreview = (context = mockContextValue) =>
  render(
    <TestProviders>
      <DocumentDetailsContext.Provider value={context}>
        <AnalyzerPreviewContainer />
      </DocumentDetailsContext.Provider>
    </TestProviders>
  );

describe('AnalyzerPreviewContainer', () => {
  describe('when newExpandableFlyoutNavigationDisabled is true', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      (useIsExperimentalFeatureEnabled as jest.Mock).mockReturnValue(true);
    });

    it('should render component and link in header', () => {
      (useIsInvestigateInResolverActionEnabled as jest.Mock).mockReturnValue(true);
      (useAlertPrevalenceFromProcessTree as jest.Mock).mockReturnValue({
        loading: false,
        error: false,
        alertIds: ['alertid'],
        statsNodes: mock.mockStatsNodes,
      });
      (useInvestigateInTimeline as jest.Mock).mockReturnValue({
        investigateInTimelineAlertClick: jest.fn(),
      });

      const { getByTestId } = renderAnalyzerPreview();

      expect(getByTestId(ANALYZER_PREVIEW_TEST_ID)).toBeInTheDocument();
      expect(
        getByTestId(EXPANDABLE_PANEL_HEADER_TITLE_LINK_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId(EXPANDABLE_PANEL_TOGGLE_ICON_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId(EXPANDABLE_PANEL_HEADER_TITLE_ICON_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).toBeInTheDocument();
      expect(
        screen.getByTestId(EXPANDABLE_PANEL_CONTENT_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId(EXPANDABLE_PANEL_HEADER_TITLE_TEXT_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId(EXPANDABLE_PANEL_CONTENT_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).not.toHaveTextContent(NO_ANALYZER_MESSAGE);
    });

    it('should render error message and text in header', () => {
      (useIsInvestigateInResolverActionEnabled as jest.Mock).mockReturnValue(false);
      (useInvestigateInTimeline as jest.Mock).mockReturnValue({
        investigateInTimelineAlertClick: jest.fn(),
      });

      const { getByTestId } = renderAnalyzerPreview();
      expect(
        getByTestId(EXPANDABLE_PANEL_HEADER_TITLE_TEXT_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).toBeInTheDocument();
      expect(
        getByTestId(EXPANDABLE_PANEL_CONTENT_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).toHaveTextContent(NO_ANALYZER_MESSAGE);
    });

    it('should open left flyout visualization tab when clicking on title', () => {
      (useIsInvestigateInResolverActionEnabled as jest.Mock).mockReturnValue(true);
      (useAlertPrevalenceFromProcessTree as jest.Mock).mockReturnValue({
        loading: false,
        error: false,
        alertIds: ['alertid'],
        statsNodes: mock.mockStatsNodes,
      });
      (useInvestigateInTimeline as jest.Mock).mockReturnValue({
        investigateInTimelineAlertClick: jest.fn(),
      });

      const { getByTestId } = renderAnalyzerPreview();

      getByTestId(EXPANDABLE_PANEL_HEADER_TITLE_LINK_TEST_ID(ANALYZER_PREVIEW_TEST_ID)).click();
      expect(mockNavigateToAnalyzer).toHaveBeenCalled();
    });

    it('should disable link when in rule preview', () => {
      (useIsInvestigateInResolverActionEnabled as jest.Mock).mockReturnValue(true);
      (useAlertPrevalenceFromProcessTree as jest.Mock).mockReturnValue({
        loading: false,
        error: false,
        alertIds: ['alertid'],
        statsNodes: mock.mockStatsNodes,
      });
      (useInvestigateInTimeline as jest.Mock).mockReturnValue({
        investigateInTimelineAlertClick: jest.fn(),
      });

      const { queryByTestId } = renderAnalyzerPreview({
        ...mockContextValue,
        isRulePreview: true,
      });
      expect(
        queryByTestId(EXPANDABLE_PANEL_HEADER_TITLE_LINK_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).not.toBeInTheDocument();
    });

    it('should disable link when in preview mode', () => {
      (useIsInvestigateInResolverActionEnabled as jest.Mock).mockReturnValue(true);
      (useAlertPrevalenceFromProcessTree as jest.Mock).mockReturnValue({
        loading: false,
        error: false,
        alertIds: ['alertid'],
        statsNodes: mock.mockStatsNodes,
      });
      (useInvestigateInTimeline as jest.Mock).mockReturnValue({
        investigateInTimelineAlertClick: jest.fn(),
      });

      const { queryByTestId } = renderAnalyzerPreview({
        ...mockContextValue,
        isPreviewMode: true,
      });
      expect(
        queryByTestId(EXPANDABLE_PANEL_HEADER_TITLE_LINK_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).not.toBeInTheDocument();
    });
  });

  describe('when newExpandableFlyoutNavigationDisabled is false', () => {
    beforeEach(() => {
      (useIsExperimentalFeatureEnabled as jest.Mock).mockReturnValue(false);
    });
    beforeEach(() => {
      (useIsInvestigateInResolverActionEnabled as jest.Mock).mockReturnValue(true);
      (useAlertPrevalenceFromProcessTree as jest.Mock).mockReturnValue({
        loading: false,
        error: false,
        alertIds: ['alertid'],
        statsNodes: mock.mockStatsNodes,
      });
      (useInvestigateInTimeline as jest.Mock).mockReturnValue({
        investigateInTimelineAlertClick: jest.fn(),
      });
    });
    it('should open left flyout visualization tab when clicking on title', () => {
      const { getByTestId } = renderAnalyzerPreview();

      getByTestId(EXPANDABLE_PANEL_HEADER_TITLE_LINK_TEST_ID(ANALYZER_PREVIEW_TEST_ID)).click();
      expect(mockNavigateToAnalyzer).toHaveBeenCalled();
    });

    it('should disable link when in rule preview', () => {
      const { queryByTestId } = renderAnalyzerPreview({
        ...mockContextValue,
        isRulePreview: true,
      });
      expect(
        queryByTestId(EXPANDABLE_PANEL_HEADER_TITLE_LINK_TEST_ID(ANALYZER_PREVIEW_TEST_ID))
      ).not.toBeInTheDocument();
    });

    it('should render link when in preview mode', () => {
      const { getByTestId } = renderAnalyzerPreview({ ...mockContextValue, isPreviewMode: true });

      getByTestId(EXPANDABLE_PANEL_HEADER_TITLE_LINK_TEST_ID(ANALYZER_PREVIEW_TEST_ID)).click();
      expect(mockNavigateToAnalyzer).toHaveBeenCalled();
    });
  });
});
