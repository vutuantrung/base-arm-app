# Coding Standard — Intent-Revealing Methods

Áp dụng cho cả hai nhánh `arm-client` và `arm-supervisor`.

## Mục tiêu

Ưu tiên code thể hiện rõ **ý định** của một bước xử lý. Người đọc
nên hiểu flow chính mà không cần phân tích biểu thức boolean dài,
mapping lặp lại hoặc khối xử lý nhiều trách nhiệm.

## Quy tắc

1. **Extract Method / Function** khi một đoạn code mô tả được bằng một tên
   nghiệp vụ ngắn và rõ ràng.
2. **Đặt tên theo ý nghĩa**, ví dụ `isInvalidRegistrationRequest`,
   `isInvalidRecoveryPolicy`, `handleRegistration`,
   `handleListApplications`.
3. **Giữ method điều phối ngắn**: kiểm tra quyền, phân tuyến, gọi handler;
   chuyển validation, mapping và xử lý nghiệp vụ vào method chuyên trách.
4. **Dùng type guard với dữ liệu không tin cậy** (HTTP payload, WebSocket,
   configuration). Kiểm tra `unknown` trước khi truy cập thuộc tính;
   tránh ép kiểu trực tiếp để lách TypeScript.
5. **Phân biệt pure function với private method**: pure function khi không
   phụ thuộc instance state; private method nếu cần `this`.
6. **Ưu tiên early return** để giảm nesting và giữ luồng xử lý chính rõ.
7. **Không extract vô nghĩa**: một biểu thức đơn giản, chỉ dùng một lần,
   không có ý nghĩa nghiệp vụ riêng thì có thể giữ inline.
8. **Không thay đổi hành vi ngầm** trong refactor. Chạy test cho cả
   happy path, malformed input và boundary conditions.

## Ví dụ 1 — Request validation

Trước:

```ts
if (!value || typeof value !== 'object'
  || typeof value.applicationId !== 'string'
  || typeof value.instanceId !== 'string'
  || typeof value.metricsUrl !== 'string') {
  sendJson(res, 400, { error: 'Invalid registration request' });
  return;
}
```

Sau:

```ts
function isRegistrationRequest(value: unknown): value is ApplicationRegistration {
  return hasStringField(value, 'applicationId')
    && hasStringField(value, 'instanceId')
    && hasStringField(value, 'metricsUrl');
}

if (!isRegistrationRequest(value)) {
  sendJson(res, 400, { error: 'Invalid registration request' });
  return;
}
```

**Lý do dùng positive type guard**: trả về `true` xác nhận dữ liệu
đủ thuộc tính cần thiết, và TypeScript có thể narrow `unknown`
sang `ApplicationRegistration`. Một `isInvalid...` trả về boolean
không đủ để narrow biến trong nhánh hợp lệ.

## Ví dụ 2 — Điều phối HTTP

Trước: một `handle()` vừa authorize, route, parse body, validate, save,
map response, unregister.

Sau: `handle()` làm routing, còn
`handleRegistration()`, `handleListApplications()`,
`handleUnregister()` đảm nhiệm từng action riêng.

## Ví dụ 3 — Validation có state

```ts
private isInvalidComponentId(id: string): boolean {
  return !VALID_ID_PATTERN.test(id) || this.registrations.has(id);
}

private isInvalidRecoveryPolicy(policy: RecoveryPolicy): boolean {
  const { maxAttempts, baseDelayMs, maxDelayMs, timeoutMs } = policy;
  const hasInvalidNumber =
    ![baseDelayMs, maxDelayMs, timeoutMs].every(Number.isFinite);

  return !Number.isInteger(maxAttempts)
    || maxAttempts < 0
    || hasInvalidNumber
    || baseDelayMs < 0
    || maxDelayMs < baseDelayMs
    || timeoutMs < 1;
}
```

## Checklist trước khi merge

- [ ] Method name giải thích **vì sao** thực hiện chứ không chỉ lặp lại syntax
- [ ] Method chính đọc được theo thứ tự xử lý nghiệp vụ
- [ ] Điều kiện phức tạp được đặt tên và có boundary tests
- [ ] Không làm giảm type safety, đặc biệt với `unknown`
- [ ] Logic chung không bị copy/paste giữa handler
- [ ] Không thêm abstraction hoặc state không cần thiết
- [ ] Build và tests không bị lỗi do refactor

## Phạm vi thay đổi ban đầu

- `arm-client`: `ReliabilityManager.register()` tách validation
  thành `isInvalidComponentId()` và `isInvalidRecoveryPolicy()`.
- `arm-supervisor`: `ApplicationRegistrationServer` tách
  request parsing, type guards và route handlers thành các function/method
  mang tên có ý nghĩa.

Các module khác sẽ áp dụng cùng tiêu chuẩn khi chỉnh sửa, không bắt buộc
refactor toàn bộ codebase cùng một lúc.
