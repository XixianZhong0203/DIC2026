export const codexModels = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low'] },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'medium'] },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', efforts: ['low', 'medium'] },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: ['low', 'medium'] },
];

export function codexSelection(model = codexModels[0].id, effort = 'low', tier = 'default') {
  const entry = codexModels.find(item => item.id === model);
  return entry?.efforts.includes(effort) && tier === 'default'
    ? { model, reasoning_effort: effort, service_tier: 'default' }
    : null;
}
