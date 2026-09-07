/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, InputNumber, Select, Switch, Toast } from '@douyinfe/semi-ui-19';
import { IconDelete, IconPlus, IconSave } from '@douyinfe/semi-icons';

import { SegmentPart } from '../../../components/segment/SegmentPart';
import { errorMessage } from '../../../services/xhr';
import { useActions, useIsLoading, useSelector } from '../../../services/state/store';
import { useTranslation } from '../../../services/i18n/i18n.jsx';

import './autoApplyPage.less';

const EMPTY_RULE = Object.freeze({
  enabled: false,
  jobIds: [],
  maxPrice: null,
  minSize: null,
  minRooms: null,
  travelTimes: [],
});

const copyRule = (rule) => ({
  ...EMPTY_RULE,
  ...(rule && typeof rule === 'object' ? rule : {}),
  jobIds: Array.isArray(rule?.jobIds) ? [...rule.jobIds] : [],
  travelTimes: Array.isArray(rule?.travelTimes) ? rule.travelTimes.map((criterion) => ({ ...criterion })) : [],
});

/**
 * One deliberately fixed auto-application rule. Blank fields simply do not participate; there is
 * no generic rule builder, nesting or technical field naming in the UI.
 *
 * @returns {React.ReactElement}
 */
export default function AutoApplyPage() {
  const t = useTranslation();
  const actions = useActions();
  const stored = useSelector((state) => state.userSettings.settings.auto_apply);
  const addresses = useSelector((state) => state.userSettings.settings.home_addresses) ?? [];
  const jobs = useSelector((state) => state.jobsData.jobs) ?? [];
  const currentUserId = useSelector((state) => state.user.currentUser?.userId);
  const saving = useIsLoading(actions.userSettings.setAutoApply);
  const [draft, setDraft] = useState(() => copyRule(stored));

  useEffect(() => setDraft(copyRule(stored)), [stored]);

  const ownJobs = useMemo(
    () => jobs.filter((job) => currentUserId == null || job.userId == null || job.userId === currentUserId),
    [jobs, currentUserId],
  );
  const addressOptions = useMemo(
    () =>
      addresses
        .map((address) => String(address?.label ?? '').trim())
        .filter(Boolean)
        .map((label) => ({ label, value: label })),
    [addresses],
  );
  const dirty = JSON.stringify(copyRule(stored)) !== JSON.stringify(draft);

  const setNumber = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value === '' || value == null ? null : Number(value) }));
  };

  const addTravelTime = () => {
    const label = addressOptions[0]?.value;
    if (!label) return;
    setDraft((current) => ({
      ...current,
      travelTimes: [...current.travelTimes, { label, mode: 'transit', maxMinutes: 20 }],
    }));
  };

  const changeTravelTime = (index, patch) => {
    setDraft((current) => ({
      ...current,
      travelTimes: current.travelTimes.map((criterion, currentIndex) =>
        currentIndex === index ? { ...criterion, ...patch } : criterion,
      ),
    }));
  };

  const removeTravelTime = (index) => {
    setDraft((current) => ({
      ...current,
      travelTimes: current.travelTimes.filter((_, currentIndex) => currentIndex !== index),
    }));
  };

  const handleSave = async () => {
    try {
      await actions.userSettings.setAutoApply(draft);
      Toast.success(t('settings.autoApplySaved'));
    } catch (error) {
      Toast.error(errorMessage(error, t('settings.autoApplySaveError')));
    }
  };

  return (
    <div className="settingsShell__page autoApplyPage">
      <SegmentPart name={t('settings.autoApplyTitle')} helpText={t('settings.autoApplyHelp')}>
        <div className="autoApplyPage__switchRow">
          <div>
            <strong>{t('settings.autoApplyEnabled')}</strong>
            <p>{t('settings.autoApplyEnabledHelp')}</p>
          </div>
          <Switch checked={draft.enabled} onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} />
        </div>
      </SegmentPart>

      <SegmentPart name={t('settings.autoApplyCriteria')} helpText={t('settings.autoApplyCriteriaHelp')}>
        <div className="autoApplyPage__criteria">
          <label>
            <span>{t('settings.autoApplyJobs')}</span>
            <Select
              multiple
              value={draft.jobIds}
              optionList={ownJobs.map((job) => ({ label: job.name || job.id, value: job.id }))}
              placeholder={t('settings.autoApplyAnyJob')}
              onChange={(jobIds) => setDraft((current) => ({ ...current, jobIds }))}
            />
          </label>

          <div className="autoApplyPage__numbers">
            <label>
              <span>{t('settings.autoApplyMaxPrice')}</span>
              <InputNumber
                min={0}
                value={draft.maxPrice}
                placeholder="—"
                onChange={(value) => setNumber('maxPrice', value)}
              />
            </label>
            <label>
              <span>{t('settings.autoApplyMinSize')}</span>
              <InputNumber
                min={0}
                value={draft.minSize}
                placeholder="—"
                onChange={(value) => setNumber('minSize', value)}
              />
            </label>
            <label>
              <span>{t('settings.autoApplyMinRooms')}</span>
              <InputNumber
                min={0}
                step={0.5}
                value={draft.minRooms}
                placeholder="—"
                onChange={(value) => setNumber('minRooms', value)}
              />
            </label>
          </div>

          <div className="autoApplyPage__travelHeader">
            <div>
              <strong>{t('settings.autoApplyTravelTime')}</strong>
              <p>{t('settings.autoApplyTravelTimeHelp')}</p>
            </div>
            <Button icon={<IconPlus />} onClick={addTravelTime} disabled={addressOptions.length === 0}>
              {t('settings.autoApplyAddTravelTime')}
            </Button>
          </div>

          {draft.travelTimes.map((criterion, index) => (
            <div className="autoApplyPage__travelRow" key={`${criterion.label}-${index}`}>
              <Select
                value={criterion.label}
                optionList={addressOptions}
                onChange={(label) => changeTravelTime(index, { label })}
              />
              <Select
                value={criterion.mode}
                optionList={[
                  { label: t('settings.autoApplyTransit'), value: 'transit' },
                  { label: t('settings.autoApplyCar'), value: 'car' },
                  { label: t('settings.autoApplyBike'), value: 'bike' },
                  { label: t('settings.autoApplyWalk'), value: 'walk' },
                ]}
                onChange={(mode) => changeTravelTime(index, { mode })}
              />
              <InputNumber
                min={1}
                value={criterion.maxMinutes}
                suffix={t('settings.autoApplyMinutesShort')}
                onChange={(maxMinutes) => changeTravelTime(index, { maxMinutes: Number(maxMinutes) })}
              />
              <Button
                type="tertiary"
                icon={<IconDelete />}
                aria-label={t('settings.autoApplyRemoveCriterion')}
                onClick={() => removeTravelTime(index)}
              />
            </div>
          ))}

          {addressOptions.length === 0 && <p className="autoApplyPage__hint">{t('settings.autoApplyNoPlaces')}</p>}
        </div>
      </SegmentPart>

      <div className="settingsShell__saveRow">
        <Button
          icon={<IconSave />}
          theme="solid"
          type="primary"
          onClick={handleSave}
          disabled={!dirty}
          loading={saving}
        >
          {t('settings.save')}
        </Button>
      </div>
    </div>
  );
}

AutoApplyPage.displayName = 'AutoApplyPage';
