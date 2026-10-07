#include "pebble.h"

ShimSlot shim_slots[SHIM_MAX_SLOTS];

void shim_reset(void) {
  for (int i = 0; i < SHIM_MAX_SLOTS; i++) {
    shim_slots[i].present = false;
    shim_slots[i].size = 0;
  }
}

static ShimSlot *slot(uint32_t key) {
  return key < SHIM_MAX_SLOTS ? &shim_slots[key] : NULL;
}

bool persist_exists(const uint32_t key) {
  ShimSlot *s = slot(key);
  return s != NULL && s->present;
}

int persist_write_data(const uint32_t key, const void *data, const size_t size) {
  ShimSlot *s = slot(key);
  if (s == NULL) return -1;
  if (size > SHIM_MAX_BYTES) return -8;   /* E_OUT_OF_STORAGE, as the watch does */
  memcpy(s->bytes, data, size);
  s->size = size;
  s->present = true;
  return (int)size;
}

int persist_read_data(const uint32_t key, void *buffer, const size_t size) {
  ShimSlot *s = slot(key);
  if (s == NULL || !s->present) return -1;
  size_t n = s->size < size ? s->size : size;
  memcpy(buffer, s->bytes, n);
  return (int)n;
}

int persist_write_string(const uint32_t key, const char *value) {
  return persist_write_data(key, value, strlen(value) + 1);
}

int persist_read_string(const uint32_t key, char *buffer, const size_t size) {
  ShimSlot *s = slot(key);
  if (s == NULL || !s->present) return -1;
  size_t n = s->size < size ? s->size : size;
  memcpy(buffer, s->bytes, n);
  buffer[n - 1] = '\0';
  return (int)strlen(buffer);
}

bool persist_read_bool(const uint32_t key) {
  ShimSlot *s = slot(key);
  return s != NULL && s->present && s->size > 0 && s->bytes[0] != 0;
}

int persist_write_bool(const uint32_t key, const bool value) {
  uint8_t byte = value ? 1 : 0;
  return persist_write_data(key, &byte, 1);
}

int persist_read_int(const uint32_t key) {
  int value = 0;
  if (persist_read_data(key, &value, sizeof(value)) < (int)sizeof(value)) return 0;
  return value;
}

int persist_write_int(const uint32_t key, const int value) {
  return persist_write_data(key, &value, sizeof(value));
}

void persist_delete(const uint32_t key) {
  ShimSlot *s = slot(key);
  if (s != NULL) { s->present = false; s->size = 0; }
}
