-- 部署前执行一次；不会修改已有表。
CREATE TABLE IF NOT EXISTS `checkin_states` (
  `id` VARCHAR(40) NOT NULL,
  `credentials` TEXT NOT NULL,
  `lastCompletedDate` DATE NULL,
  `leaseToken` CHAR(36) BINARY NULL,
  `leaseUntil` DATETIME NULL,
  `createdAt` DATETIME NOT NULL,
  `updatedAt` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
