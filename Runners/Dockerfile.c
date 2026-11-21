FROM alpine:3.20

# Install GCC and standard C headers/libraries
RUN apk add --no-cache gcc musl-dev

WORKDIR /code
RUN chown 65534:65534 /code

USER 65534:65534

CMD ["sh"]