import pino from "pino";

// Настраиваем транспорт для pino-pretty
const transport = pino.transport({
    target: 'pino-pretty',
    options: {
        colorize: true, // Включаем цветной вывод
        translateTime: 'SYS:standard', // Форматируем временные метки
        ignore: 'pid,hostname', // Убираем лишние поля
    },
});

export const logger = pino(
    {
        level: 'info',
        redact: ['poolKeys'], // Скрываем чувствительные данные
        serializers: {
            error: pino.stdSerializers.err, // Сериализация ошибок
        },
        base: undefined, // Убираем базовые поля (например, pid, hostname)
    },
    transport
);