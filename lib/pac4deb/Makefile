CC ?= gcc
CFLAGS ?= -O2 -fPIC
CFLAGS += -Wall -Wextra -Iinclude
LDFLAGS += -shared -ldl

SRC = $(wildcard src/*.c)
OBJ = $(SRC:.c=.o)
TARGET = libalpm.so

.PHONY: all clean install

all: $(TARGET)

$(TARGET): $(OBJ)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(TARGET) src/*.o

install: $(TARGET)
	install -Dm755 $(TARGET) /usr/local/lib/$(TARGET)
	ldconfig
	@echo "Installed to /usr/local/lib/$(TARGET)"
