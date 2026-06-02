export function generateUniqueId(): string {
  const length = 8; // Length of the ID
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // Characters to include in the ID
  let id = '';

  // Generate random bytes and map them to the charset
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length);
    id += charset[randomIndex];
  }

  return id;
}

export function getStartAndEndDateOfWeek(selectedDate: Date): {
  startDate: Date;
  endDate: Date;
} {
  const currentDate = new Date(selectedDate);
  const currentDayOfWeek = currentDate.getDay(); // 0 for Sunday, 1 for Monday, ..., 6 for Saturday

  // Calculate the start date of the week
  const startDate = new Date(currentDate);
  startDate.setDate(currentDate.getDate() - currentDayOfWeek);

  // Calculate the end date of the week
  const endDate = new Date(currentDate);
  endDate.setDate(currentDate.getDate() + (6 - currentDayOfWeek));

  // Set time to the beginning of the day for both start and end dates
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);

  return {startDate, endDate};
}

export const formatRFQId = (rfqId: number) =>
  `RFQ${rfqId.toString().padStart(4, '0')}`;
