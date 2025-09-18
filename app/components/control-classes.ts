// Shared control classnames for consistent input/select styling across forms
// Centralized to keep Step 1 (new) and Step 2 (review) aligned.

export const CONTROL_BASE = 'mt-1 block w-full rounded-md text-sm'
export const INPUT_CLS = `${CONTROL_BASE} border border-gray-300 bg-white px-3 h-10 text-gray-900 focus:border-indigo-500 focus:ring-indigo-500`
export const SELECT_CLS = `${CONTROL_BASE} border border-gray-300 bg-white pl-3 pr-10 h-10 text-gray-900 focus:border-indigo-500 focus:ring-indigo-500`
export const READONLY_CLS = `${CONTROL_BASE} border border-gray-200 bg-gray-50 px-3 h-10 text-gray-700`
export const TEXTAREA_CLS = `${CONTROL_BASE} border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:border-indigo-500 focus:ring-indigo-500`
