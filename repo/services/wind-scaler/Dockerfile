FROM alpine:3.20
RUN apk add --no-cache curl
COPY scale.sh /scale.sh
RUN chmod +x /scale.sh
CMD ["/scale.sh"]
